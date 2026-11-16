// Frontend side of the Stockfish session in `src-tauri/src/engine.rs`.

import { Channel, invoke } from "@tauri-apps/api/core";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import { type Arrow, fenTurn } from "./board";
import { type GameResult, type Score, shareFor } from "./score";

export type EngineInfo = { name: string; threads: number; hashMb: number };

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

type EngineEvent = ({ type: "update" } & AnalysisUpdate) | { type: "error"; message: string };

export const fetchEngineInfo = () => invoke<EngineInfo>("engine_info");

/** The evaluation of an analysed position: its best line's score, or its result. */
export function positionScore(update: AnalysisUpdate | undefined): Score | undefined {
  if (!update) return undefined;
  if (update.outcome) return { result: update.outcome };
  return update.lines[0]?.score;
}

/**
 * Analyses `fen()` while `enabled()`, starting a new search whenever the position changes.
 *
 * Keeps the deepest analysis seen for every position, so revisiting one shows what is already
 * known while the engine catches up, and the eval graph can plot every analysed ply.
 */
export function createEngineAnalysis(options: {
  fen: Accessor<string>;
  enabled: Accessor<boolean>;
  multipv: number;
}) {
  const [byFen, setByFen] = createStore<Record<string, AnalysisUpdate>>({});
  const [error, setError] = createSignal<string>();
  // Bumped for every search so late messages from an earlier one are ignored.
  let generation = 0;

  const record = (update: AnalysisUpdate) => {
    const known = byFen[update.fen];
    if (!known || update.depth >= known.depth) setByFen(update.fen, update);
  };

  createEffect(() => {
    const fen = options.fen();
    const enabled = options.enabled();
    const search = ++generation;
    setError(undefined);
    if (!enabled) {
      void invoke("engine_stop").catch(() => {});
      return;
    }

    const channel = new Channel<EngineEvent>();
    channel.onmessage = (event) => {
      if (search !== generation) return;
      if (event.type === "error") {
        setError(event.message);
        return;
      }
      const { type: _, ...update } = event;
      record(update);
    };
    invoke("engine_analyze", { fen, multipv: options.multipv, onEvent: channel }).catch(
      (reason) => {
        if (search === generation) setError(String(reason));
      },
    );
  });

  onCleanup(() => {
    generation++;
    void invoke("engine_stop").catch(() => {});
  });

  return {
    /** The deepest analysis of `fen` so far. */
    analysisOf: (fen: string): AnalysisUpdate | undefined => byFen[fen],
    /** Why the engine failed for the current position, if it did. */
    error,
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
