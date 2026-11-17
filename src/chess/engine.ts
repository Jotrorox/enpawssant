// Frontend side of the Stockfish session in `src-tauri/src/engine.rs`.

import { Channel, invoke } from "@tauri-apps/api/core";
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { type Arrow, fenTurn } from "./board";
import { engineRevision } from "./engines";
import { type GameResult, type Score, shareFor } from "./score";

/** `threads` and `hashMb` are only known for engines with those options. */
export type EngineInfo = { name: string; threads: number | null; hashMb: number | null };

export type EngineLine = {
  multipv: number;
  depth: number;
  /** White-relative. */
  score: Score;
  san: string[];
  uci: string[];
};

export type AnalysisUpdate = {
  fen: string;
  /** Depth and selective depth of the best line. */
  depth: number;
  seldepth: number;
  nodes: number;
  nps: number;
  timeMs: number;
  /** Best line first. */
  lines: EngineLine[];
  /** Set when the side to move is checkmated or stalemated; there are no lines then. */
  outcome: GameResult | null;
};

type EngineEvent =
  | ({ type: "update" } & AnalysisUpdate)
  /** Ends every search; `complete` when it reached its depth rather than being replaced. */
  | { type: "done"; complete: boolean }
  | { type: "error"; message: string };

/** Progress of a full-game review, in positions. */
export type ReviewProgress = { done: number; total: number };

export const fetchEngineInfo = (engineId: string) =>
  invoke<EngineInfo>("engine_info", { engineId });

/** The evaluation of an analysed position: its best line's score, or its result. */
export function positionScore(update: AnalysisUpdate | undefined): Score | undefined {
  if (!update) return undefined;
  if (update.outcome) return { result: update.outcome };
  return update.lines[0]?.score;
}

/**
 * Analyses `fen()` with engine `engineId()` while `enabled()`, starting a new search whenever the
 * position changes. Without an engine nothing is analysed.
 *
 * Keeps the deepest analysis seen for every position, so revisiting one shows what is already
 * known while the engine catches up, and the eval graph can plot every analysed ply.
 *
 * `review` searches a list of positions to a fixed depth instead. The live search pauses while it
 * runs, since there is only one engine, and picks up the current position when it ends.
 */
export function createEngineAnalysis(options: {
  engineId: Accessor<string | undefined>;
  fen: Accessor<string>;
  enabled: Accessor<boolean>;
  multipv: number;
}) {
  const [byFen, setByFen] = createStore<Record<string, AnalysisUpdate>>({});
  const [error, setError] = createSignal<string>();
  const [progress, setProgress] = createSignal<ReviewProgress>();
  const [reviewError, setReviewError] = createSignal<string>();
  const reviewing = createMemo(() => progress() !== undefined);
  // Bumped for every search so late messages from an earlier one are ignored.
  let generation = 0;
  // Bumped for every review, so a cancelled one stops at its next step.
  let reviewRun = 0;
  /** The depth each position was searched to by a review, which may report a shallower depth. */
  const reviewedDepth = new Map<string, number>();

  const record = (update: AnalysisUpdate) => {
    const known = byFen[update.fen];
    // At equal depth, keep the update with more lines: a review's single line shouldn't replace
    // the live search's MultiPV lines.
    if (
      !known ||
      update.depth > known.depth ||
      (update.depth === known.depth && update.lines.length >= known.lines.length)
    ) {
      setByFen(update.fen, update);
    }
  };

  // Another engine (or the same one with new options) judges positions differently, so what the
  // previous one found is dropped.
  createEffect(
    on(
      () => [options.engineId(), options.engineId() && engineRevision(options.engineId() ?? "")],
      () => {
        setByFen(reconcile({}));
        reviewedDepth.clear();
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const fen = options.fen();
    const enabled = options.enabled();
    const engineId = options.engineId();
    if (engineId) engineRevision(engineId);
    const search = ++generation;
    // The review owns the engine; its requests replace whatever was running.
    if (reviewing()) return;
    setError(undefined);
    if (!engineId) return;
    if (!enabled) {
      void invoke("engine_stop", { engineId }).catch(() => {});
      return;
    }
    // An engine that loses its role is stopped by `engines_set_roles` in Rust; stopping it here
    // could also stop it in the role it just took on.

    const channel = new Channel<EngineEvent>();
    channel.onmessage = (event) => {
      if (search !== generation) return;
      if (event.type === "error") {
        setError(event.message);
      } else if (event.type === "update") {
        const { type: _, ...update } = event;
        record(update);
      }
      // A live search is only ever `done` because it was replaced or stopped.
    };
    invoke("engine_analyze", { engineId, fen, multipv: options.multipv, onEvent: channel }).catch(
      (reason) => {
        if (search === generation) setError(String(reason));
      },
    );
  });

  onCleanup(() => {
    generation++;
    reviewRun++;
    const engineId = options.engineId();
    if (engineId) void invoke("engine_stop", { engineId }).catch(() => {});
  });

  /** Searches `fen` to `depth`, resolving with whether the search got there. */
  const searchToDepth = (engineId: string, fen: string, depth: number) =>
    new Promise<boolean>((resolve, reject) => {
      const channel = new Channel<EngineEvent>();
      channel.onmessage = (event) => {
        if (event.type === "update") {
          const { type: _, ...update } = event;
          record(update);
        } else if (event.type === "done") {
          resolve(event.complete);
        } else {
          reject(new Error(event.message));
        }
      };
      invoke("engine_analyze", { engineId, fen, multipv: 1, depth, onEvent: channel }).catch(
        reject,
      );
    });

  const searchedTo = (fen: string, depth: number) => {
    const known = byFen[fen];
    return (
      !!known && (!!known.outcome || Math.max(known.depth, reviewedDepth.get(fen) ?? 0) >= depth)
    );
  };

  /**
   * Searches every position in `fens` to `depth`, skipping positions already searched as deep.
   * Resolves with each position's evaluation, or `undefined` when cancelled or the engine failed.
   */
  const review = async (fens: readonly string[], depth: number) => {
    const engineId = options.engineId();
    if (!engineId) return undefined;
    const run = ++reviewRun;
    setReviewError(undefined);
    setProgress({ done: 0, total: fens.length });
    try {
      for (const [index, fen] of fens.entries()) {
        if (!searchedTo(fen, depth)) {
          const complete = await searchToDepth(engineId, fen, depth);
          if (run !== reviewRun || !complete) return undefined;
          reviewedDepth.set(fen, Math.max(depth, reviewedDepth.get(fen) ?? 0));
        }
        setProgress({ done: index + 1, total: fens.length });
      }
      return fens.map((fen) => positionScore(byFen[fen]));
    } catch (reason) {
      if (run === reviewRun)
        setReviewError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      if (run === reviewRun) setProgress(undefined);
    }
  };

  return {
    /** The deepest analysis of `fen` so far. */
    analysisOf: (fen: string): AnalysisUpdate | undefined => byFen[fen],
    /** Why the engine failed for the current position, if it did. */
    error,
    review,
    /** Why the last review failed, if it did. */
    reviewError,
    /** How far the running review is, if one is running. */
    reviewProgress: progress,
    /** Stops the running review; it resolves with `undefined`. */
    cancelReview: () => {
      reviewRun++;
      setProgress(undefined);
    },
  };
}

/** Arrows for the first move of each line, weighted by how close the line is to the best one. */
export function lineArrows(update: AnalysisUpdate): Arrow[] {
  const [best, ...rest] = update.lines;
  if (!best) return [];
  const side = fenTurn(update.fen);
  const bestShare = shareFor(best.score, side);
  const arrow = (line: EngineLine, strength: number): Arrow[] => {
    const move = line.uci[0];
    return move ? [{ from: move.slice(0, 2), to: move.slice(2, 4), strength }] : [];
  };
  return [
    ...arrow(best, 1),
    ...rest.flatMap((line) => {
      const loss = bestShare - shareFor(line.score, side);
      return arrow(line, Math.min(0.6, Math.max(0.15, 0.6 - 3 * loss)));
    }),
  ];
}
