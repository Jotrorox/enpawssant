// In-app updates. Release builds look for `latest.json` on the newest GitHub release (see
// `plugins.updater` in `src-tauri/tauri.conf.json`), and only install bundles signed with the
// matching key. The release workflow writes and signs them; see `docs/releasing.md`.

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { createRoot, createSignal } from "solid-js";

/** A newer release found by {@link checkForUpdates}. */
export type UpdateInfo = {
  version: string;
  /** Release notes from `latest.json`, if any. */
  notes: string | null;
};

/** Bytes fetched so far; `total` is null when the server sends no length. */
export type DownloadProgress = { downloaded: number; total: number | null };

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; info: UpdateInfo }
  | { status: "downloading"; info: UpdateInfo; progress: DownloadProgress }
  | { status: "ready"; info: UpdateInfo }
  | { status: "error"; message: string; info: UpdateInfo | null };

/** Whether we run inside the Tauri shell (false in a plain browser or under Vitest). */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const state = createRoot(() => {
  const [update, setUpdate] = createSignal<UpdateState>({ status: "idle" });
  const [version, setVersion] = createSignal<string>();
  if (inTauri) {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }
  return { update, setUpdate, version };
});

/** Where the updater is. */
export const updateState = state.update;
/** The running app's version, once known. */
export const appVersion = state.version;

/** The update from the last check, kept to install it. */
let pending: Update | null = null;

const errorText = (error: unknown) =>
  typeof error === "string" ? error : error instanceof Error ? error.message : String(error);

/**
 * Looks for a newer release and resolves to it, or to null when there is none. A `quiet` check (at
 * launch) never reports errors: being offline is not worth a message.
 */
export async function checkForUpdates({ quiet = false } = {}): Promise<UpdateInfo | null> {
  const current = state.update();
  if (!inTauri) return null;
  if (current.status === "checking" || current.status === "downloading") return null;
  if (current.status === "ready") return current.info;
  state.setUpdate({ status: "checking" });
  try {
    const update = await check();
    const previous = pending;
    pending = update;
    if (previous) void previous.close().catch(() => {});
    if (!update) {
      state.setUpdate({ status: "current" });
      return null;
    }
    const info = { version: update.version, notes: update.body?.trim() || null };
    state.setUpdate({ status: "available", info });
    return info;
  } catch (error) {
    state.setUpdate(
      quiet ? { status: "idle" } : { status: "error", message: errorText(error), info: null },
    );
    return null;
  }
}

/**
 * Downloads, verifies and installs the update from the last check. On Windows the installer then
 * closes the app itself; elsewhere call {@link restartApp}.
 */
export async function installUpdate() {
  const current = state.update();
  const info = current.status === "available" || current.status === "error" ? current.info : null;
  if (!info || !pending) return;
  const update = pending;
  let downloaded = 0;
  let total: number | null = null;
  state.setUpdate({ status: "downloading", info, progress: { downloaded, total } });
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? null;
      else if (event.event === "Progress") downloaded += event.data.chunkLength;
      else if (total !== null) downloaded = total;
      state.setUpdate({ status: "downloading", info, progress: { downloaded, total } });
    });
    state.setUpdate({ status: "ready", info });
  } catch (error) {
    state.setUpdate({ status: "error", message: errorText(error), info });
  }
}

/** Restarts into the installed update. */
export async function restartApp() {
  await invoke("relaunch");
}
