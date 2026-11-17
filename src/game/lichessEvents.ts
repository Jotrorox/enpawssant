// The signed-in account's life on Lichess, shared by the whole app: the event stream (games
// starting and finishing, challenges arriving and going away), the list of ongoing games and the
// seek in progress. The stream runs while an account that may play is signed in, and reconnects
// when it drops; Lichess sends the current games and challenges every time it connects.

import { batch, createEffect, createRoot, createSignal, on } from "solid-js";
import { lichessAccount, markSignedOut } from "../chess/lichess";
import {
  type AccountEvent,
  applyAccountEvent,
  type Challenge,
  describeLichessError,
  type GameInfo,
  type GameRequest,
  type LichessStream,
  ongoingGames,
  respondToChallenge,
  seekGame,
  streamAccountEvents,
  toLichessError,
} from "../chess/lichessPlay";

/** Waits between reconnection attempts, growing up to the last one, in ms. */
const RETRY_MS = [2000, 5000, 10_000, 30_000, 60_000];

type GameStartListener = (game: GameInfo) => void;

const store = createRoot(() => {
  const [connected, setConnected] = createSignal(false);
  const [challenges, setChallenges] = createSignal<Challenge[]>([]);
  const [games, setGames] = createSignal<GameInfo[]>([]);
  const [seeking, setSeeking] = createSignal<GameRequest>();
  const [seekError, setSeekError] = createSignal<string>();
  const startListeners = new Set<GameStartListener>();
  const challengeListeners = new Set<(challenge: Challenge) => void>();
  /** Challenges seen on this connection, so only new ones are announced. */
  const announced = new Set<string>();
  let seekStream: LichessStream | undefined;
  let session = 0;
  /** Stops the event stream of the current session. */
  const stoppers = new Set<() => void>();

  const canPlay = () => {
    const state = lichessAccount();
    return state.status === "signedIn" && state.account.canPlay
      ? state.account.username
      : undefined;
  };

  const apply = (event: AccountEvent) => {
    const next = applyAccountEvent({ challenges: challenges(), games: games() }, event);
    batch(() => {
      setChallenges(next.challenges);
      setGames(next.games);
    });
    if (event.type === "gameStart") {
      for (const listener of startListeners) listener(event.game);
    } else if (event.type === "challenge" && !announced.has(event.challenge.id)) {
      announced.add(event.challenge.id);
      for (const listener of challengeListeners) listener(event.challenge);
    }
  };

  /** Refreshes the ongoing games, which also brings turns and time left up to date. */
  const refreshGames = async () => {
    if (!canPlay()) return;
    try {
      setGames(await ongoingGames());
    } catch (reason) {
      if (toLichessError(reason).kind === "signedOut") markSignedOut();
    }
  };

  const run = async (current: number) => {
    let failures = 0;
    while (current === session) {
      // The stream resends what's current, so stale entries go.
      setChallenges([]);
      const stream = streamAccountEvents((event) => {
        if (current !== session) return;
        setConnected(true);
        failures = 0;
        apply(event);
      });
      const stop = () => stream.stop();
      stoppers.add(stop);
      void refreshGames();
      try {
        await stream.done;
      } catch (reason) {
        if (toLichessError(reason).kind === "signedOut") {
          markSignedOut();
          return;
        }
        failures += 1;
      } finally {
        stoppers.delete(stop);
      }
      if (current !== session) return;
      setConnected(false);
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]),
      );
    }
  };

  createEffect(
    on(canPlay, (username) => {
      session += 1;
      for (const stop of stoppers) stop();
      seekStream?.stop();
      batch(() => {
        setConnected(false);
        setChallenges([]);
        setGames([]);
        setSeeking(undefined);
      });
      announced.clear();
      if (username) void run(session);
    }),
  );

  const seek = async (request: GameRequest) => {
    if (seeking()) return;
    setSeekError(undefined);
    const stream = seekGame(request);
    // Correspondence seeks stay on Lichess and resolve at once.
    const realtime = request.clock.type === "clock";
    if (realtime) {
      seekStream = stream;
      setSeeking(request);
    }
    try {
      await stream.done;
      return true;
    } catch (reason) {
      setSeekError(describeLichessError(toLichessError(reason)));
      return false;
    } finally {
      if (realtime && seekStream === stream) {
        seekStream = undefined;
        setSeeking(undefined);
      }
    }
  };

  return {
    connected,
    challenges,
    games,
    seeking,
    seekError,
    seek,
    cancelSeek: () => seekStream?.stop(),
    refreshGames,
    respond: async (challenge: Challenge, action: "accept" | "decline" | "cancel") => {
      await respondToChallenge(challenge.id, action);
      setChallenges((list) => list.filter((c) => c.id !== challenge.id));
    },
    /** Adds a challenge the user just sent, before the event stream reports it. */
    addChallenge: (challenge: Challenge) => {
      announced.add(challenge.id);
      setChallenges((list) => [...list.filter((c) => c.id !== challenge.id), challenge]);
    },
    onGameStart: (listener: GameStartListener) => {
      startListeners.add(listener);
      return () => startListeners.delete(listener);
    },
    onChallenge: (listener: (challenge: Challenge) => void) => {
      challengeListeners.add(listener);
      return () => challengeListeners.delete(listener);
    },
  };
});

export const lichessEvents = store;
