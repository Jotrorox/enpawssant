// Frontend side of the file browser in `src-tauri/src/files.rs`, plus the list of recently
// opened PGN files, which is kept in local storage.

import { invoke } from "@tauri-apps/api/core";
import { createRoot, createSignal } from "solid-js";
import type { OpenedPgn } from "./pgn";

export type Place = { name: string; path: string };

export type FileEntry = {
  name: string;
  path: string;
  kind: "folder" | "pgn";
  size: number;
  /** Milliseconds since the epoch. */
  modified: number | null;
};

export type Listing = { path: string; parent: string | null; entries: FileEntry[] };

export const filePlaces = () => invoke<Place[]>("files_places");

export const listFolder = (path: string) => invoke<Listing>("files_list", { path });

/** Shows a folder picker, resolving to `null` when cancelled. */
export const pickFolder = () => invoke<string | null>("files_pick_folder");

export const readPgnFile = (path: string) => invoke<OpenedPgn>("pgn_read_path", { path });

export type RecentFile = {
  path: string;
  name: string;
  /** Games read from the file, the last time it was opened. */
  games: number;
  /** Milliseconds since the epoch. */
  openedAt: number;
};

const STORAGE_KEY = "enpawssant.recentFiles";
const MAX_RECENT = 12;

/** Adds or moves `file` to the front of `list`, keeping at most `MAX_RECENT` files. */
export function withRecent(list: RecentFile[], file: RecentFile): RecentFile[] {
  return [file, ...list.filter((entry) => entry.path !== file.path)].slice(0, MAX_RECENT);
}

export function parseRecent(text: string | null): RecentFile[] {
  if (!text) return [];
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (entry): entry is RecentFile =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.path === "string" &&
          typeof entry.name === "string" &&
          typeof entry.games === "number" &&
          typeof entry.openedAt === "number",
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

const recent = createRoot(() => {
  let initial: RecentFile[] = [];
  try {
    initial = parseRecent(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage may be unavailable; start without recent files.
  }
  return createSignal(initial);
});

export const recentFiles = recent[0];

function saveRecent(list: RecentFile[]) {
  recent[1](list);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Not remembering recent files is fine.
  }
}

/** Remembers a file that was just opened. */
export function rememberFile(opened: Pick<OpenedPgn, "path" | "name" | "games">) {
  saveRecent(
    withRecent(recentFiles(), {
      path: opened.path,
      name: opened.name,
      games: opened.games.length,
      openedAt: Date.now(),
    }),
  );
}

export function forgetFile(path: string) {
  saveRecent(recentFiles().filter((entry) => entry.path !== path));
}

/** A size such as `12 KB` or `3.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The folder names from the root down to `path`, each with its full path, for breadcrumbs. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const windows = /^[A-Za-z]:\\/.test(path) || path.includes("\\");
  const separator = windows ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  const crumbs: { name: string; path: string }[] = [];
  let current = windows ? "" : "/";
  if (!windows) crumbs.push({ name: "/", path: "/" });
  for (const part of parts) {
    current =
      windows && current === ""
        ? `${part}${separator}`
        : `${current}${current.endsWith(separator) ? "" : separator}${part}`;
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

/** `just now`, `5 min ago`, `3 days ago`… */
export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(at).toLocaleDateString();
}
