// A game against Stockfish, played in a tab's session. The game is the session's main line: the
// user moves at its end, the engine answers there, and the clock runs alongside. Like the session,
// it outlives the tab's view, so the clock keeps running while another tab is open.

import { batch, createEffect, createRoot, createSignal, onCleanup, untrack } from "solid-js";
import { type Color, fenTurn } from "../chess/board";
import { requestOpponentMove, type Strength } from "../chess/engine";
import {
  type Outcome,
  pgnTermination,
  resignationOutcome,
  rulesOutcome,
  timeoutOutcome,
} from "../chess/outcome";
import { mainline } from "../chess/review";
import { type MoveInput, parseUciMove } from "../chess/rules";
import {
  type ClockState,
  halt,
  newClock,
  pgnTimeControl,
  press,
  remaining,
  start,
  type TimeControl,
} from "./clock";
import type { GameSession } from "./session";

export type PlaySettings = {
  /** The side the user plays. */
  color: Color;
  strength: Strength;
  /** Without one, the game is untimed. */
  timeControl?: TimeControl;
};

export type EngineGame = ReturnType<typeof createEngineGame>;

/** How often the clock display updates and checks for a flag fall, in ms. */
const TICK_MS = 100;

const other = (side: Color): Color => (side === "w" ? "b" : "w");

/** The engine's name with its strength, e.g. `Stockfish 19 (1500)` or `Stockfish 19 (level 5)`. */
export function opponentName(engineName: string, strength: Strength): string {
  return "elo" in strength
    ? `${engineName} (${strength.elo})`
    : `${engineName} (level ${strength.skill})`;
}

/** PGN headers for a new game against the engine. */
export function engineGameHeaders(
  settings: PlaySettings,
  engineName: string,
  date = new Date(),
): [string, string][] {
  const engine = opponentName(engineName, settings.strength);
  const [white, black] = settings.color === "w" ? ["You", engine] : [engine, "You"];
  const pad = (value: number) => String(value).padStart(2, "0");
  const headers: [string, string][] = [
    ["Event", "Casual game"],
    ["Site", "EnPawssant"],
    ["Date", `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`],
    ["White", white],
    ["Black", black],
    ["Result", "*"],
  ];
  if ("elo" in settings.strength) {
    headers.push([settings.color === "w" ? "BlackElo" : "WhiteElo", String(settings.strength.elo)]);
  }
  headers.push(["TimeControl", pgnTimeControl(settings.timeControl)]);
  return headers;
}

/** Runs a game against the engine in `session`. Call `dispose` when its tab closes. */
export function createEngineGame(session: GameSession, settings: PlaySettings) {
  return createRoot((dispose) => {
    const engineSide = other(settings.color);
    const control = settings.timeControl;
    const startFen = session.tree.nodes[session.tree.rootId].fen;

    const [outcome, setOutcome] = createSignal<Outcome>();
    const [error, setError] = createSignal<string>();
    const [thinking, setThinking] = createSignal(false);
    const [now, setNow] = createSignal(performance.now());
    const [clock, setClock] = createSignal<ClockState | undefined>(
      control && start(newClock(control), fenTurn(startFen), performance.now()),
    );
    /** The engine forgets its last game with its first request of this one. */
    let firstRequest = true;
    /** Bumped for every search, so only the latest one clears `thinking`. */
    let searches = 0;

    const line = () => mainline(session.tree);
    /** The last position of the game, where the next move is played. */
    const endId = () => {
      const ids = line();
      return ids[ids.length - 1];
    };
    const endFen = () => session.tree.nodes[endId()].fen;
    const turn = () => fenTurn(endFen());
    const playing = () => outcome() === undefined;

    const finish = (result: Outcome) => {
      if (!playing()) return;
      batch(() => {
        setOutcome(result);
        setClock((current) => current && halt(current, performance.now()));
        session.setHeader("Result", result.result);
        session.setHeader("Termination", pgnTermination(result));
      });
    };

    /**
     * Plays `side`'s move after `parentId`, hands the clock over and ends the game if the rules
     * say so, all before effects see the new position. Returns whether the move was legal.
     */
    const playMove = (side: Color, parentId: string, input: MoveInput, follow: boolean) =>
      batch(() => {
        const at = performance.now();
        if (!session.playFrom(parentId, input, follow)) return false;
        if (control)
          setClock((current) => current && press(current, side, at, control.incrementMs));
        const ended = rulesOutcome(line().map((id) => session.tree.nodes[id].fen));
        if (ended) finish(ended);
        return true;
      });

    // Keep the running clock on the side to move, even when moves are deleted from the game.
    createEffect(() => {
      const side = turn();
      if (!playing() || error()) return;
      setClock((current) =>
        current && current.running !== side ? start(current, side, performance.now()) : current,
      );
    });

    // Ask the engine whenever it is its turn. Its answer only counts if the game is still where
    // it was; anything else (the game ending, the tab closing) aborts the search.
    createEffect(() => {
      const id = endId();
      if (!playing() || turn() !== engineSide || error()) return;
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      untrack(() => void think(id, controller.signal));
    });

    const think = async (id: string, signal: AbortSignal) => {
      const search = ++searches;
      setThinking(true);
      const current = clock();
      const at = performance.now();
      const moves = line()
        .slice(1)
        .map((node) => session.tree.nodes[node].move?.uci ?? "");
      try {
        const uci = await requestOpponentMove(
          {
            fen: startFen,
            moves,
            strength: settings.strength,
            clock:
              current && control
                ? {
                    whiteMs: Math.round(remaining(current, "w", at)),
                    blackMs: Math.round(remaining(current, "b", at)),
                    whiteIncMs: control.incrementMs,
                    blackIncMs: control.incrementMs,
                  }
                : undefined,
            newGame: firstRequest,
          },
          signal,
        );
        firstRequest = false;
        if (signal.aborted || endId() !== id || !playing()) return;
        // Follow the game only when the user is watching its end.
        const follow = session.currentId() === id;
        if (!uci || !playMove(engineSide, id, parseUciMove(uci), follow)) {
          throw new Error(
            uci ? `the engine played an illegal move (${uci})` : "the engine had no move",
          );
        }
      } catch (reason) {
        if (signal.aborted) return;
        batch(() => {
          setClock((paused) => paused && halt(paused, performance.now()));
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      } finally {
        if (search === searches) setThinking(false);
      }
    };

    const timer = setInterval(() => {
      const at = performance.now();
      setNow(at);
      const current = clock();
      if (playing() && current?.running && remaining(current, current.running, at) <= 0) {
        finish(timeoutOutcome(endFen(), current.running));
      }
    }, TICK_MS);
    onCleanup(() => clearInterval(timer));

    return {
      settings,
      outcome,
      playing,
      /** Whether the engine is choosing its move. */
      thinking,
      /** Why the engine failed, if it did; the game is paused until `retry`. */
      error,
      /** Whose turn it is in the game. */
      turn,
      /** The last position of the game, where play continues. */
      endId,
      /** Time left for `side`, or `undefined` in an untimed game. */
      timeLeft: (side: Color) => {
        const current = clock();
        return current && remaining(current, side, now());
      },
      /** The side whose clock is running. */
      clockRunning: () => clock()?.running,
      /** Whether the board should take the user's moves: on their turn, at the end of the game. */
      canMove: () =>
        playing() && !error() && turn() === settings.color && session.currentId() === endId(),
      /** Plays the user's move at the end of the game. */
      move: (input: MoveInput) => {
        if (!playing() || turn() !== settings.color || session.currentId() !== endId()) return;
        playMove(settings.color, endId(), input, true);
      },
      resign: () => finish(resignationOutcome(settings.color)),
      retry: () => {
        if (!error()) return;
        batch(() => {
          setClock((paused) => paused && start(paused, engineSide, performance.now()));
          setError(undefined);
        });
      },
      dispose,
    };
  });
}
