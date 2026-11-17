// Importing a player's games from Lichess or Chess.com (`src-tauri/src/online.rs`).

import { invoke } from "@tauri-apps/api/core";
import type { Color } from "./board";
import { header, type ParsedPgn, type PgnGame } from "./pgn";

export type OnlineSite = "lichess" | "chesscom";

export const SITE_NAMES: Record<OnlineSite, string> = {
  lichess: "Lichess",
  chesscom: "Chess.com",
};

/** Which games to fetch: the latest ones, or those played between two times (ms since epoch). */
export type GameFilter =
  | { kind: "latest"; count: number }
  | { kind: "between"; since: number | null; until: number | null };

/** Games fetched at most in one go; the backend enforces the same limit. */
export const MAX_ONLINE_GAMES = 200;

/** Fetches a player's games, newest first. Rejects with a message fit to show. */
export const fetchOnlineGames = (site: OnlineSite, username: string, filter: GameFilter) =>
  invoke<ParsedPgn>(site === "lichess" ? "lichess_games" : "chesscom_games", {
    username,
    filter,
  });

/**
 * A filter for games played between two local dates (`YYYY-MM-DD`, as date inputs give them),
 * both days included. An empty date leaves that end open.
 */
export function dateRange(from: string, to: string): GameFilter {
  return {
    kind: "between",
    since: from ? localDay(from).getTime() : null,
    until: to ? endOfDay(localDay(to)).getTime() : null,
  };
}

function localDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function endOfDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, -1);
}

/** A day as `YYYY-MM-DD` in local time, as date inputs take it. */
export function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The colour `username` played in `game`, if they played in it. */
export function colorOf(game: Pick<PgnGame, "headers">, username: string): Color | undefined {
  const name = username.trim().toLowerCase();
  if (!name) return undefined;
  if (header(game, "White")?.toLowerCase() === name) return "w";
  if (header(game, "Black")?.toLowerCase() === name) return "b";
  return undefined;
}

const STORAGE_KEY = "enpawssant.online";

/** The username last used on each site. */
export function rememberedUsername(site: OnlineSite): string {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof saved[site] === "string" ? saved[site] : "";
  } catch {
    return "";
  }
}

export function rememberUsername(site: OnlineSite, username: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, [site]: username }));
  } catch {
    // Storage may be unavailable; the name then has to be typed again next time.
  }
}
