#!/usr/bin/env node
// Downloads the latest official Stockfish release for the current Rust host
// (or `--target <triple>`) and places it where Tauri's `externalBin` expects it:
//   src-tauri/binaries/stockfish-<target-triple>[.exe]
//
// Usage: node scripts/fetch-stockfish.mjs [--force] [--target <triple>]
//   --force   re-download even if the binary already exists
//   --target  Rust target triple to fetch for (defaults to `rustc -vV` host)
//
// Set GITHUB_TOKEN to avoid GitHub API rate limits (e.g. on CI).

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = "official-stockfish/Stockfish";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(ROOT, "src-tauri", "binaries");
const ARCHIVE_EXT = String.raw`\.(?:tar|tar\.gz|tgz|tar\.xz|zip)$`;

// Asset name stems per target triple, most preferred first. Older releases ship
// CPU-specific builds (m1-apple-silicon, avx2, ...); newer ones ship "universal"
// builds that pick the best code path at runtime.
const ASSET_PREFERENCES = [
  [
    /^aarch64-apple-darwin$/,
    ["macos-m1-apple-silicon", "macos-(?:arm64|aarch64)", "macos-universal"],
  ],
  [/^x86_64-apple-darwin$/, ["macos-x86-64-avx2", "macos-x86-64", "macos-universal"]],
  [/^x86_64-pc-windows-/, ["windows-x86-64-avx2", "windows-x86-64-universal", "windows-x86-64"]],
];

function parseArgs(argv) {
  const args = { force: false, target: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--target") args.target = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: ROOT, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function hostTriple() {
  const host = run("rustc", ["-vV"]).match(/^host:\s*(\S+)/m)?.[1];
  if (!host) throw new Error("Could not read the host target triple from `rustc -vV`.");
  return host;
}

function selectAsset(assets, triple) {
  const stems = ASSET_PREFERENCES.find(([pattern]) => pattern.test(triple))?.[1];
  if (!stems) throw new Error(`No Stockfish build mapping for target ${triple}.`);
  for (const stem of stems) {
    const pattern = new RegExp(`^stockfish-${stem}(?:-[\\w-]+)?${ARCHIVE_EXT}`, "i");
    const match = assets
      .filter((a) => pattern.test(a.name))
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    if (match) return match;
  }
  const names = assets.map((a) => `  ${a.name}`).join("\n");
  throw new Error(`No Stockfish asset matches target ${triple}. Available assets:\n${names}`);
}

async function githubJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "enpawssant-fetch-stockfish",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok)
    throw new Error(`GitHub API ${url} returned ${response.status} ${response.statusText}`);
  return response.json();
}

async function download(url, destination) {
  const response = await fetch(url, { headers: { "User-Agent": "enpawssant-fetch-stockfish" } });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function extract(archive, destination) {
  const isWindows = process.platform === "win32";
  if (archive.endsWith(".zip") && isWindows) {
    run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:SF_ARCHIVE -DestinationPath $env:SF_DEST -Force",
      ],
      { env: { ...process.env, SF_ARCHIVE: archive, SF_DEST: destination } },
    );
  } else if (archive.endsWith(".zip")) {
    run("unzip", ["-q", archive, "-d", destination]);
  } else {
    // Use the bsdtar shipped with Windows, not a GNU tar from Git Bash on PATH.
    const tar = isWindows
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
    run(tar, ["-xf", archive, "-C", destination]);
  }
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** The engine binary is the largest `stockfish*` executable in the archive. */
async function findEngineBinary(dir, windowsBinary) {
  let best;
  for await (const path of walk(dir)) {
    const name = path.split(/[\\/]/).pop().toLowerCase();
    if (!name.startsWith("stockfish")) continue;
    const info = await stat(path);
    const isCandidate = windowsBinary
      ? name.endsWith(".exe")
      : !name.includes(".") && (info.mode & 0o111) !== 0;
    if (isCandidate && (!best || info.size > best.size)) best = { path, size: info.size };
  }
  if (!best) throw new Error("Could not find the Stockfish executable in the downloaded archive.");
  return best.path;
}

function verify(binary) {
  const result = spawnSync(binary, [], { input: "uci\nquit\n", encoding: "utf8", timeout: 15_000 });
  const name = result.stdout?.match(/^id name (.+)$/m)?.[1]?.trim();
  if (!name || !/^uciok$/m.test(result.stdout)) {
    throw new Error(
      `The downloaded engine did not complete the UCI handshake.\n${result.stderr ?? ""}`,
    );
  }
  return name;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = hostTriple();
  const triple = args.target ?? host;
  const windowsBinary = triple.includes("windows");
  const destination = join(BIN_DIR, `stockfish-${triple}${windowsBinary ? ".exe" : ""}`);

  if (existsSync(destination) && !args.force) {
    console.log(`Stockfish already present at ${destination} (use --force to re-download).`);
    return;
  }

  const release = await githubJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  const asset = selectAsset(release.assets ?? [], triple);
  console.log(`Fetching ${release.name ?? release.tag_name}: ${asset.name} for ${triple}`);

  const workDir = await mkdtemp(join(tmpdir(), "enpawssant-stockfish-"));
  try {
    const archive = join(workDir, asset.name);
    const extracted = join(workDir, "extracted");
    await mkdir(extracted);
    await download(asset.browser_download_url, archive);
    extract(archive, extracted);

    const binary = await findEngineBinary(extracted, windowsBinary);
    if (!windowsBinary) await chmod(binary, 0o755);
    // Only verify binaries we can run here; cross-target fetches are copied as-is.
    if (triple === host) console.log(`Verified engine: ${verify(binary)}`);

    await mkdir(BIN_DIR, { recursive: true });
    await copyFile(binary, destination);
    if (!windowsBinary) await chmod(destination, 0o755);
    console.log(`Installed ${destination}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`fetch-stockfish: ${error.message}`);
  process.exit(1);
});
