// Frontend side of the opening explorer in `src-tauri/src/explorer.rs`, and of its "My games"
// source, the local game database (`src-tauri/src/database.rs`).

import { invoke } from "@tauri-apps/api/core";
import { type Accessor, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { Color } from "./board";
import { databaseVersion, exploreDatabase } from "./database";

export type ExplorerSource = "masters" | "lichess" | "mine";

export type ResultCounts = { white: number; draws: number; black: number };

export type ExplorerMove = ResultCounts & {
  /** Standard UCI (castling as `e1g1`). */
  uci: string;
  san: string;
  averageRating: number | null;
};

export type ExplorerResult = ResultCounts & {
  /** Most played first. */
  moves: ExplorerMove[];
};

export type Opening = { eco: string; name: string };

export type ExplorerError =
  | { kind: "signedOut" }
  | { kind: "rateLimited" }
  | { kind: "failed"; message: string };

export type ExplorerState =
  | { status: "off" }
  /** `previous` is the result for the last position, shown until the new one arrives. */
  | { status: "loading"; previous?: ExplorerResult }
  | { status: "ready"; result: ExplorerResult }
  | { status: "error"; error: ExplorerError };

/** Wait this long after the position changes, so stepping through a game doesn't flood Lichess. */
const DEBOUNCE_MS = 250;
/** The local database answers quickly, so it waits less. */
const LOCAL_DEBOUNCE_MS = 80;
const CACHE_SIZE = 500;

/** Results by source and position, shared by every tab for the whole session. */
const cache = new Map<string, ExplorerResult>();

function remember(key: string, result: ExplorerResult) {
  cache.delete(key);
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** A FEN without its move counters, so transpositions share explorer results. */
export function positionKey(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

export type ResultShares = { white: number; draw: number; black: number };

/** Whole percentages of wins, draws and losses that add up to 100 (or 0 without games). */
export function resultShares(counts: ResultCounts): ResultShares {
  const total = counts.white + counts.draws + counts.black;
  if (total === 0) return { white: 0, draw: 0, black: 0 };
  const white = Math.round((100 * counts.white) / total);
  const black = Math.min(100 - white, Math.round((100 * counts.black) / total));
  return { white, draw: 100 - white - black, black };
}

export function totalGames(counts: ResultCounts): number {
  return counts.white + counts.draws + counts.black;
}

/**
 * Explorer results for `fen()` from `source()` while `enabled()`. Results are cached, and requests
 * wait until the position has stayed put for a moment.
 */
export function createExplorer(options: {
  fen: Accessor<string>;
  source: Accessor<ExplorerSource>;
  /** For "My games": only the games in which the user had this colour. */
  side?: Accessor<Color | undefined>;
  enabled: Accessor<boolean>;
  /** Called when Lichess no longer accepts the account's token. */
  onSignedOut: () => void;
}) {
  const [state, setState] = createSignal<ExplorerState>({ status: "off" });
  const [attempt, setAttempt] = createSignal(0);
  let request = 0;

  createEffect(() => {
    attempt();
    const fen = options.fen();
    const source = options.source();
    const current = ++request;
    if (!options.enabled()) {
      setState({ status: "off" });
      return;
    }
    const local = source === "mine";
    const side = local ? options.side?.() : undefined;
    if (local) databaseVersion();
    const key = `${source}:${positionKey(fen)}`;
    // The local database changes with every import, so its results are not cached.
    const cached = local ? undefined : cache.get(key);
    if (cached) {
      setState({ status: "ready", result: cached });
      return;
    }

    const shown = untrack(state);
    const previous =
      shown.status === "ready"
        ? shown.result
        : shown.status === "loading"
          ? shown.previous
          : undefined;
    setState({ status: "loading", previous });
    const timer = setTimeout(
      () => {
        const fetched = local
          ? exploreDatabase(fen, side)
          : invoke<ExplorerResult>("explorer_moves", { source, fen });
        fetched
          .then((result) => {
            if (!local) remember(key, result);
            if (current === request) setState({ status: "ready", result });
          })
          .catch((reason: unknown) => {
            const error = asExplorerError(reason);
            if (error.kind === "signedOut") options.onSignedOut();
            if (current === request) setState({ status: "error", error });
          });
      },
      local ? LOCAL_DEBOUNCE_MS : DEBOUNCE_MS,
    );
    onCleanup(() => clearTimeout(timer));
  });

  return {
    state,
    /** Asks again after an error. */
    retry: () => setAttempt((n) => n + 1),
  };
}

function asExplorerError(reason: unknown): ExplorerError {
  if (reason && typeof reason === "object" && "kind" in reason) return reason as ExplorerError;
  return { kind: "failed", message: String(reason) };
}

/** The opening a line of positions is in: the last named one of `fens`. */
export const fetchOpeningName = (fens: string[]) =>
  invoke<Opening | null>("opening_name", { fens });
