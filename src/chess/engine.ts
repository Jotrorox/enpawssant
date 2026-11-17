// Frontend side of the engine sessions in `src-tauri/src/engine.rs`.

import { Channel, invoke } from "@tauri-apps/api/core";
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { type Arrow, fenTurn } from "./board";
import { engineRevision } from "./engines";
import { type GameResult, type Score, shareFor } from "./score";

/** The values an engine option can take. */
export type StrengthRange = { min: number; max: number; default: number };

export type EngineInfo = {
  name: string;
  /** Only known for engines with `Threads` and `Hash` options. */
  threads: number | null;
  hashMb: number | null;
  /** The Elo range the engine can limit itself to, if it can. */
  elo: StrengthRange | null;
  /** The range of its skill levels, if it has them. */
  skill: StrengthRange | null;
};

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
  /**
   * Ends every search; `complete` when it ended on its own rather than being replaced or stopped.
   * A completed search names the move the engine chose.
   */
  | { type: "done"; complete: boolean; bestmove?: string }
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
   * Searches every position in `fens` to `depth`, skipping positions already searched as deep and
   * those `skip` says are done. Hands each result to `onResult` as soon as it is in, with the depth
   * it was searched to, so a stopped review keeps what it found. Resolves with whether every
   * position got done; stopping it or an engine failure resolves with `false`.
   */
  const review = async (
    fens: readonly string[],
    depth: number,
    handlers: {
      skip?: (index: number) => boolean;
      onResult: (index: number, update: AnalysisUpdate, depth: number) => void;
    },
  ): Promise<boolean> => {
    const engineId = options.engineId();
    if (!engineId) return false;
    const run = ++reviewRun;
    setReviewError(undefined);
    setProgress({ done: 0, total: fens.length });
    try {
      for (const [index, fen] of fens.entries()) {
        if (!handlers.skip?.(index)) {
          if (!searchedTo(fen, depth)) {
            const complete = await searchToDepth(engineId, fen, depth);
            if (run !== reviewRun || !complete) return false;
            reviewedDepth.set(fen, Math.max(depth, reviewedDepth.get(fen) ?? 0));
          }
          const update = byFen[fen];
          if (update) {
            handlers.onResult(index, update, Math.max(update.depth, reviewedDepth.get(fen) ?? 0));
          }
        }
        setProgress({ done: index + 1, total: fens.length });
      }
      return true;
    } catch (reason) {
      if (run === reviewRun)
        setReviewError(reason instanceof Error ? reason.message : String(reason));
      return false;
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
    /** Stops the running review; it resolves with `false`. */
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

/** How strongly the opponent plays: limited to an Elo, or at one of Stockfish's skill levels. */
export type Strength = { elo: number } | { skill: number };

/** Both players' time left and increments, in milliseconds. */
export type OpponentClock = {
  whiteMs: number;
  blackMs: number;
  whiteIncMs: number;
  blackIncMs: number;
};

export type OpponentRequest = {
  /** Where the game started. */
  fen: string;
  /** UCI moves played since, so the engine sees repetitions. */
  moves: string[];
  strength: Strength;
  /** Without a clock the engine thinks for about a second. */
  clock?: OpponentClock;
  /** Set for the first request of a game, so the engine forgets the last one. */
  newGame: boolean;
};

/** Starts the engine that games are played against and describes it. */
export const fetchOpponentInfo = () => invoke<EngineInfo>("opponent_info");

/** There is one opponent engine, so games in different tabs take turns asking it. */
let opponentQueue: Promise<unknown> = Promise.resolve();

/**
 * Asks the opponent engine for its move, in UCI notation. Resolves with `undefined` when `signal`
 * aborts first, and rejects when the engine fails.
 */
export function requestOpponentMove(
  request: OpponentRequest,
  signal: AbortSignal,
): Promise<string | undefined> {
  const turn = opponentQueue.then(() =>
    signal.aborted ? undefined : searchOpponentMove(request, signal),
  );
  opponentQueue = turn.catch(() => {});
  return turn;
}

function searchOpponentMove(request: OpponentRequest, signal: AbortSignal) {
  return new Promise<string | undefined>((resolve, reject) => {
    const stop = () => void invoke("opponent_stop").catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    const settle = (finish: () => void) => {
      signal.removeEventListener("abort", stop);
      finish();
    };
    const channel = new Channel<EngineEvent>();
    channel.onmessage = (event) => {
      if (event.type === "done") {
        settle(() => resolve(event.complete && !signal.aborted ? event.bestmove : undefined));
      } else if (event.type === "error") {
        settle(() => reject(new Error(event.message)));
      }
    };
    invoke("opponent_move", { ...request, clock: request.clock ?? null, onEvent: channel }).catch(
      (reason) => settle(() => reject(new Error(String(reason)))),
    );
  });
}
