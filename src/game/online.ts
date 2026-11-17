// A game on lichess.org, played in a tab's session through the Board API. Lichess is the source of
// truth: the game stream's states decide the moves, clocks and result, and the session's main line
// follows them. The user's own moves show at once and are confirmed (or undone) by the stream.
// Like the session, the game outlives the tab's view, and it reconnects when the stream drops.

import { batch, createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js";
import { type Color, fenTurn } from "../chess/board";
import { markSignedOut } from "../chess/lichess";
import {
  chatHistory,
  describeLichessError,
  type GameAction,
  type GameFull,
  type GameState,
  type GameStreamEvent,
  gameAction,
  gameMoves,
  initialFen,
  inProgress,
  type LichessStream,
  lichessHeaders,
  lichessOutcome,
  playerName,
  playMove,
  sendChat,
  streamGame,
  toLichessError,
  userColor,
} from "../chess/lichessPlay";
import { pgnTermination } from "../chess/outcome";
import { mainline } from "../chess/review";
import { type MoveInput, parseUciMove } from "../chess/rules";
import { type ClockState, press, remaining } from "./clock";
import { createPremove, otherSide } from "./played";
import type { GameSession } from "./session";

export type OnlineGame = ReturnType<typeof createOnlineGame>;

/** `live` once the stream delivers; `closed` after the game ended or the stream gave up. */
export type Connection = "connecting" | "live" | "reconnecting" | "closed";

export type ChatMessage = { user: string; text: string };

/** How often the clock display updates, in ms. */
const TICK_MS = 100;
/** Waits between reconnection attempts, growing up to the last one, in ms. */
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
/** Attempts without ever reaching the game before giving up. */
const MAX_FAILED_STARTS = 6;
/** How long to wait after Lichess rate limited the app, in ms. */
const RATE_LIMIT_MS = 60_000;
/** Lichess's sentinel for "no clock" in correspondence and unlimited games. */
const NO_CLOCK_MS = 2_000_000_000;

export type OnlineGameOptions = {
  /** The signed-in user, to tell which side they play. */
  username: () => string | undefined;
  /** The user's side, when known before the game arrives (e.g. against the AI). */
  color?: Color;
};

/**
 * Brings the main line of `session` in line with `moves`: drops moves Lichess doesn't have (a
 * takeback, or a move it refused) and plays the ones it has on top. `pending` is the user's move
 * that Lichess hasn't confirmed yet; a state from before it doesn't undo it. Returns the first move
 * that couldn't be played, if any.
 */
export function syncMainline(
  session: Pick<GameSession, "tree" | "currentId" | "remove" | "playFrom">,
  moves: readonly string[],
  pending?: string,
): string | undefined {
  const ids = mainline(session.tree);
  const local = ids.slice(1).map((id) => session.tree.nodes[id].move?.uci);
  const waitingForPending =
    pending !== undefined &&
    local.length === moves.length + 1 &&
    local[local.length - 1] === pending &&
    moves.every((uci, index) => local[index] === uci);
  if (waitingForPending) return undefined;
  let common = 0;
  while (common < moves.length && common < local.length && local[common] === moves[common]) {
    common++;
  }
  if (common < local.length) session.remove(ids[common + 1]);
  let parent = ids[common];
  for (const uci of moves.slice(common)) {
    const follow = session.currentId() === parent;
    const id = session.playFrom(parent, parseUciMove(uci), follow);
    if (!id) return uci;
    parent = id;
  }
  return undefined;
}

/** Plays game `gameId` on Lichess in `session`. Call `dispose` when its tab closes. */
export function createOnlineGame(session: GameSession, gameId: string, options: OnlineGameOptions) {
  return createRoot((dispose) => {
    const [full, setFull] = createSignal<GameFull>();
    const [state, setState] = createSignal<GameState>();
    const [connection, setConnection] = createSignal<Connection>("connecting");
    /** Why the last action failed, or why the game can't be followed. */
    const [error, setError] = createSignal<string>();
    const [chat, setChat] = createSignal<ChatMessage[]>([]);
    /** When the opponent left, and when the game can be claimed (as `performance.now()` time). */
    const [opponentGone, setOpponentGone] = createSignal<{ claimAt?: number }>();
    /** Deadline for the first moves, after which Lichess aborts the game. */
    const [firstMoveBy, setFirstMoveBy] = createSignal<number>();
    const [clock, setClock] = createSignal<ClockState>();
    const [now, setNow] = createSignal(performance.now());
    /** The action being sent, so its button can wait. */
    const [sending, setSending] = createSignal<GameAction>();
    /** The user's move Lichess hasn't confirmed yet, and how many moves came before it. */
    const [pending, setPending] = createSignal<{ uci: string; ply: number }>();
    let disposed = false;
    let stream: LichessStream | undefined;

    /** The user's side, settled once the game is matched to the signed-in user. */
    const [side, setSide] = createSignal<Color>();
    createEffect(() => {
      const game = full();
      const username = options.username();
      const found = game && username && userColor(game, username);
      if (found && !side()) setSide(found);
    });
    const color = (): Color => side() ?? options.color ?? "w";
    /** Moves wait until it's clear which side is the user's. */
    const sideKnown = () => side() !== undefined || options.color !== undefined;
    const line = () => mainline(session.tree);
    const endId = () => {
      const ids = line();
      return ids[ids.length - 1];
    };
    const turn = () => fenTurn(session.tree.nodes[endId()].fen);
    const moveCount = () => line().length - 1;
    const outcome = createMemo(() => {
      const current = state();
      return current && lichessOutcome(current);
    });
    // A game is on until Lichess says otherwise, so fair play starts before it has loaded.
    const playing = () => outcome() === undefined && connection() !== "closed";
    const isAi = () => !!(full()?.white.aiLevel || full()?.black.aiLevel);
    const correspondence = () => full()?.speed === "correspondence";
    const opponent = () => {
      const game = full();
      return game && (color() === "w" ? game.black : game.white);
    };

    /** Clocks for real-time games, and correspondence games when Lichess sends real times. */
    const updateClock = (current: GameState) => {
      const game = full();
      const timed =
        !!game?.clock ||
        (!!game?.daysPerTurn && current.wtime < NO_CLOCK_MS && current.btime < NO_CLOCK_MS);
      if (!timed) {
        setClock(undefined);
        return;
      }
      // Lichess starts real-time clocks once both players have moved.
      const started = correspondence() || gameMoves(current).length >= 2;
      setClock({
        white: current.wtime,
        black: current.btime,
        running: inProgress(current.status) && started ? turn() : undefined,
        since: performance.now(),
      });
    };

    const applyState = (current: GameState) => {
      batch(() => {
        setState(current);
        const moves = gameMoves(current);
        const waiting = pending();
        // Confirmed, or Lichess went on without it.
        if (waiting && moves.length > waiting.ply) setPending(undefined);
        const unknown = syncMainline(session, moves, pending()?.uci);
        if (unknown) setError(`Lichess sent a move Mochi can't play here (${unknown}).`);
        updateClock(current);
        const expiration = current.expiration;
        setFirstMoveBy(
          expiration && inProgress(current.status) && moves.length < 2
            ? performance.now() + expiration.millisToMove - expiration.idleMillis
            : undefined,
        );
        const ended = lichessOutcome(current);
        if (ended) {
          session.setHeader("Result", ended.result);
          session.setHeader("Termination", pgnTermination(ended));
          setOpponentGone(undefined);
        }
      });
    };

    const applyFull = (game: GameFull) => {
      batch(() => {
        setFull(game);
        const headers = lichessHeaders(game);
        const startFen = initialFen(game);
        if (session.tree.nodes[session.tree.rootId].fen !== startFen) {
          session.reset({ headers, startFen, moves: [] });
        } else {
          for (const [name, value] of headers) {
            if (name !== "Result") session.setHeader(name, value);
          }
        }
        applyState(game.state);
      });
      if (!isAi()) {
        chatHistory(gameId)
          .then((lines) => !disposed && setChat(lines))
          .catch(() => {});
      }
    };

    const onEvent = (event: GameStreamEvent) => {
      if (disposed) return;
      setConnection("live");
      switch (event.type) {
        case "gameFull":
          applyFull(event);
          break;
        case "gameState":
          applyState(event);
          break;
        case "chatLine":
          if (event.room === "player") {
            setChat((lines) => [...lines, { user: event.username, text: event.text }]);
          }
          break;
        case "opponentGone":
          setOpponentGone(
            event.gone
              ? {
                  claimAt:
                    event.claimWinInSeconds === undefined
                      ? undefined
                      : performance.now() + event.claimWinInSeconds * 1000,
                }
              : undefined,
          );
          break;
      }
    };

    // Follow the game until it ends, reconnecting when the stream drops while it's on.
    const follow = async () => {
      let failures = 0;
      while (!disposed) {
        setConnection(full() ? "reconnecting" : "connecting");
        const current = streamGame(gameId, onEvent);
        stream = current;
        try {
          const closedByLichess = await current.done;
          if (disposed || !closedByLichess) return;
          // Lichess closes the stream when the game is over.
          if (state() && !inProgress(state()?.status ?? "started")) {
            setConnection("closed");
            return;
          }
          failures = 0;
        } catch (reason) {
          if (disposed) return;
          const problem = toLichessError(reason);
          if (problem.kind === "signedOut") {
            markSignedOut();
            setError(describeLichessError(problem));
            setConnection("closed");
            return;
          }
          // Being rate limited isn't the game's fault: wait it out without giving up.
          if (problem.kind === "rateLimited") {
            setConnection("reconnecting");
            await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS));
            continue;
          }
          failures += 1;
          if (!full() && failures >= MAX_FAILED_STARTS) {
            setError(`Mochi couldn't reach this game: ${describeLichessError(problem)}`);
            setConnection("closed");
            return;
          }
        }
        setConnection("reconnecting");
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]),
        );
      }
    };
    void follow();

    const timer = setInterval(() => setNow(performance.now()), TICK_MS);
    // Nothing ticks once the game is over.
    createEffect(() => {
      if (connection() === "closed") clearInterval(timer);
    });
    onCleanup(() => {
      disposed = true;
      clearInterval(timer);
      stream?.stop();
    });

    /** Sends an action, keeping its button busy and reporting a failure. */
    const act = async (action: GameAction) => {
      if (sending()) return;
      setError(undefined);
      setSending(action);
      try {
        await gameAction(gameId, action);
      } catch (reason) {
        setError(describeLichessError(toLichessError(reason)));
      } finally {
        setSending(undefined);
      }
    };

    const canMove = () =>
      !!full() &&
      sideKnown() &&
      playing() &&
      !pending() &&
      turn() === color() &&
      session.currentId() === endId();

    const move = (input: MoveInput) => {
      if (!canMove()) return;
      const side = color();
      const id = batch(() => {
        const played = session.playFrom(endId(), input, true);
        const increment = full()?.clock?.increment ?? 0;
        if (played) {
          setClock((current) =>
            current?.running ? press(current, side, performance.now(), increment) : current,
          );
        }
        return played;
      });
      const uci = id && session.tree.nodes[id].move?.uci;
      if (!uci) return;
      setError(undefined);
      setPending({ uci, ply: moveCount() - 1 });
      playMove(gameId, uci).catch((reason) => {
        if (disposed) return;
        batch(() => {
          setPending(undefined);
          setError(describeLichessError(toLichessError(reason)));
          // Back to what Lichess last said.
          const current = state();
          if (current) applyState(current);
        });
      });
    };

    const canPremove = () =>
      !!full() && sideKnown() && playing() && turn() !== color() && session.currentId() === endId();
    const premoves = createPremove({ canMove, canPremove, move });

    const offers = (side: Color) => {
      const current = state();
      return {
        draw: !!(side === "w" ? current?.wdraw : current?.bdraw),
        takeback: !!(side === "w" ? current?.wtakeback : current?.btakeback),
      };
    };

    return {
      kind: "online" as const,
      gameId,
      full,
      color,
      outcome,
      playing,
      turn,
      endId,
      connection,
      error,
      chat,
      sending,
      isAi,
      correspondence,
      /** The opponent's name for display, e.g. `Lichess AI level 3`. */
      opponentName: () => {
        const player = opponent();
        return player ? playerName(player) : "Opponent";
      },
      timeLeft: (side: Color) => {
        const current = clock();
        return current && remaining(current, side, now());
      },
      clockRunning: () => clock()?.running,
      /** Seconds left to make the first move before Lichess aborts the game. */
      firstMoveSeconds: () => {
        const deadline = firstMoveBy();
        return deadline === undefined ? undefined : Math.max(0, (deadline - now()) / 1000);
      },
      /** Whether the opponent left; `claimIn` counts down to when the game can be claimed. */
      opponentGone: () => {
        const gone = opponentGone();
        if (!gone) return undefined;
        return {
          claimIn:
            gone.claimAt === undefined ? undefined : Math.max(0, (gone.claimAt - now()) / 1000),
        };
      },
      /** Lichess lets either player abort until both have moved. */
      canAbort: () => playing() && moveCount() < 2,
      /** What the user and the opponent are offering: a draw, taking back a move. */
      yourOffers: () => offers(color()),
      theirOffers: () => offers(otherSide(color())),
      /** Whether waiting for Lichess to confirm the user's move. */
      confirming: () => pending() !== undefined,
      canMove,
      move,
      canPremove,
      premove: premoves.premove,
      setPremove: premoves.setPremove,
      resign: () => void act("resign"),
      abort: () => void act("abort"),
      offerDraw: () => void act("drawYes"),
      acceptDraw: () => void act("drawYes"),
      declineDraw: () => void act("drawNo"),
      proposeTakeback: () => void act("takebackYes"),
      acceptTakeback: () => void act("takebackYes"),
      declineTakeback: () => void act("takebackNo"),
      claimVictory: () => void act("claimVictory"),
      claimDraw: () => void act("claimDraw"),
      say: async (text: string) => {
        try {
          await sendChat(gameId, text);
          return true;
        } catch (reason) {
          setError(describeLichessError(toLichessError(reason)));
          return false;
        }
      },
      dismissError: () => setError(undefined),
      dispose,
    };
  });
}
