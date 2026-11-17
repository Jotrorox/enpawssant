# CI and releases

- **CI** (`.github/workflows/ci.yml`): `mise run check` (clippy, rustfmt, tsc, Biome, actionlint)
  and `mise run test` on macOS, Windows and Linux.
- **Release** (`.github/workflows/release.yml`): pushing a `v*` tag builds, each with Stockfish
  bundled:
  - macOS: a universal `.dmg` (Apple silicon and Intel)
  - Windows: `.msi` and `.exe` installers
  - Linux: an `.AppImage` and a `.deb`, built on Ubuntu 22.04 so they also run on older systems

  It attaches them to a **draft** GitHub Release. With the updater key set, the release also gets
  signed updater bundles and a `latest.json` that installed apps read.
- **Dependabot** (`.github/dependabot.yml`) opens grouped weekly PRs for Cargo, npm and GitHub
  Actions. It can't bump `mise.toml` or `rust-toolchain.toml`.

## Cutting a release

```sh
mise run release 0.2.0                # bumps every manifest, commits "Release v0.2.0", tags v0.2.0
git push origin main --follow-tags    # starts the release workflow
```

When the workflow is green:

1. Open the draft on the [Releases page](https://github.com/Jotrorox/enpawssant/releases).
   GitHub has already filled in the merged PRs.
2. Add a short summary above the generated notes, plus a downloads table and install notes as
   needed (see the template below).
3. Publish it. Installed apps only see the update once it is published and marked **Latest**,
   because the updater reads `releases/latest/download/latest.json`.

If a build fails, fix it and run the workflow again on the same tag (_Actions → Release → Re-run
failed jobs_). The workflow reuses the existing draft and replaces assets with the same name.

To build the universal macOS bundle locally, fetch its engine first:
`node scripts/fetch-stockfish.mjs --target universal-apple-darwin`, then
`mise run build -- --target universal-apple-darwin`.

### Release notes template

```md
One or two sentences on what's new.

## Downloads

| Platform                        | File                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| macOS (Apple silicon and Intel) | `EnPawssant_X.Y.Z_universal.dmg`                                       |
| Windows x64                     | `EnPawssant_X.Y.Z_x64-setup.exe` or `EnPawssant_X.Y.Z_x64_en-US.msi`   |
| Linux x64                       | `EnPawssant_X.Y.Z_amd64.AppImage` or `EnPawssant_X.Y.Z_amd64.deb`      |

Already installed? EnPawssant offers the update itself at launch, or go to Settings → Updates.

### macOS

The app is signed with a Developer ID and notarized by Apple, so it opens without warnings.

### Windows: "Windows protected your PC"

The Windows builds are not code-signed yet, so Microsoft Defender SmartScreen shows a warning the
first time you run the installer. Click **More info**, then **Run anyway**.
```

## In-app updates

The app uses [Tauri's updater](https://v2.tauri.app/plugin/updater/). At launch it fetches
`latest.json` from the newest published release and offers the update in Settings (and under
_EnPawssant → Check for Updates…_ on macOS). It only installs bundles signed with the private key
whose public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.

The key pair was generated with `pnpm tauri signer generate -w ~/.tauri/enpawssant.key`. The
private key and its password are in `~/.tauri/enpawssant.key{,.password}` and in the `release`
environment secrets below. **Back them up somewhere safe** (a password manager). If the key is
lost, installed apps can no longer be updated and users have to download the next version by hand.

Local and CI builds don't need the key: `createUpdaterArtifacts` is off in `tauri.conf.json`, and
the release workflow switches it on only when `TAURI_SIGNING_PRIVATE_KEY` is set.

## Secrets

Everything is optional. Without a secret, that part is skipped: the app is ad-hoc signed on macOS,
the Windows installers are unsigned, and the release gets no updater files. Add them as secrets of
the `release` environment (_Settings → Environments → release_, restricted to `v*` tags), e.g.
`gh secret set APPLE_ID --env release`:

| Secret                               | Purpose                                                  |
| ------------------------------------ | -------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of `~/.tauri/enpawssant.key` (updater signing)  |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password of that key                                     |
| `APPLE_CERTIFICATE`                  | Base64 of the exported "Developer ID Application" `.p12` |
| `APPLE_CERTIFICATE_PASSWORD`         | Password of that `.p12`                                  |
| `APPLE_SIGNING_IDENTITY`             | e.g. `Developer ID Application: Your Name (TEAMID)`      |
| `APPLE_ID`                           | Apple ID email used for notarization                     |
| `APPLE_PASSWORD`                     | App-specific password for that Apple ID                  |
| `APPLE_TEAM_ID`                      | 10-character team ID                                     |
| `WINDOWS_CERTIFICATE`                | Base64 of a code-signing `.pfx`                          |
| `WINDOWS_CERTIFICATE_PASSWORD`       | Password of that `.pfx`                                  |

macOS signing needs the three certificate secrets. Notarization also needs the three Apple ID
secrets. With notarization on, both the app and the `.dmg` are notarized and stapled. See
[Tauri: macOS code signing](https://v2.tauri.app/distribute/sign/macos/) and
[Windows code signing](https://v2.tauri.app/distribute/sign/windows/).
