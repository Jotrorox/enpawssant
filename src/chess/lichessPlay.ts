// Playing on lichess.org through the Board API. Requests and streams go through Rust
// (`src-tauri/src/board.rs`), which holds the token; this module types what Lichess sends and
// turns it into what the app needs.

import { Channel, invoke } from "@tauri-apps/api/core";
import { type Color, START_FEN } from "./board";
import type { Outcome, Termination } from "./outcome";

/** Why a request failed, as Rust reports it. */
export type LichessError =
  | { kind: "signedOut" }
  | { kind: "rateLimited" }
  | { kind: "notFound" }
  | { kind: "failed"; message: string };

export function toLichessError(reason: unknown): LichessError {
  if (reason && typeof reason === "object" && "kind" in reason) return reason as LichessError;
  return { kind: "failed", message: String(reason) };
}

export function describeLichessError(error: LichessError): string {
  switch (error.kind) {
    case "signedOut":
      return "You're signed out of Lichess. Sign in again to play.";
    case "rateLimited":
      return "Lichess asked Mochi to slow down. Try again in a minute.";
    case "notFound":
      return "Lichess doesn't know that game or player.";
    case "failed":
      return error.message;
  }
}

export type LichessColor = "white" | "black";

export const toColor = (color: LichessColor): Color => (color === "white" ? "w" : "b");

export type GameStatus =
  | "created"
  | "started"
  | "aborted"
  | "mate"
  | "resign"
  | "stalemate"
  | "timeout"
  | "draw"
  | "outoftime"
  | "cheat"
  | "noStart"
  | "unknownFinish"
  | "insufficientMaterialClaim"
  | "variantEnd";

export type Speed = "ultraBullet" | "bullet" | "blitz" | "rapid" | "classical" | "correspondence";

/** A player as the game stream describes them. */
export type GamePlayer = {
  id?: string | null;
  name?: string;
  title?: string | null;
  rating?: number;
  provisional?: boolean;
  /** Set for the Lichess AI. */
  aiLevel?: number;
};

export type GameState = {
  type: "gameState";
  /** UCI moves, separated by spaces. */
  moves: string;
  /** Time left, in ms. */
  wtime: number;
  btime: number;
  winc: number;
  binc: number;
  status: GameStatus;
  winner?: LichessColor;
  /** Whether each side offers a draw or asks to take back a move. */
  wdraw?: boolean;
  bdraw?: boolean;
  wtakeback?: boolean;
  btakeback?: boolean;
  /** The time left to make the first move, before both players have moved. */
  expiration?: { idleMillis: number; millisToMove: number };
};

export type GameFull = {
  type: "gameFull";
  id: string;
  variant: { key: string; name: string };
  speed: Speed;
  perf: { name: string };
  rated: boolean;
  createdAt: number;
  white: GamePlayer;
  black: GamePlayer;
  /** `startpos` or a FEN. */
  initialFen: string;
  /** In ms; missing for correspondence and unlimited games. */
  clock?: { initial: number; increment: number } | null;
  daysPerTurn?: number;
  state: GameState;
};

export type ChatLine = {
  type: "chatLine";
  room: "player" | "spectator";
  username: string;
  text: string;
};

export type OpponentGone = { type: "opponentGone"; gone: boolean; claimWinInSeconds?: number };

export type GameStreamEvent = GameFull | GameState | ChatLine | OpponentGone;

/** An ongoing game, as the event stream and the list of ongoing games describe it. */
export type GameInfo = {
  gameId: string;
  fullId?: string;
  color: LichessColor;
  fen: string;
  hasMoved?: boolean;
  isMyTurn: boolean;
  lastMove?: string;
  opponent: { id?: string | null; username: string; rating?: number; ai?: number };
  perf?: string;
  rated?: boolean;
  secondsLeft?: number | null;
  source?: string;
  speed?: Speed;
  status?: { id: number; name: GameStatus };
  winner?: LichessColor;
  /** Whether the Board API can play the game; it can't play bullet, for one. */
  compat?: { bot: boolean; board: boolean };
};

export type ChallengeUser = { id: string; name: string; rating?: number; title?: string | null };

export type ChallengeTimeControl =
  | { type: "clock"; limit: number; increment: number; show?: string }
  | { type: "correspondence"; daysPerTurn: number }
  | { type: "unlimited" };

export type Challenge = {
  id: string;
  url: string;
  status: "created" | "offline" | "canceled" | "declined" | "accepted";
  challenger: ChallengeUser;
  destUser: ChallengeUser | null;
  variant: { key: string; name: string };
  rated: boolean;
  speed: Speed;
  timeControl: ChallengeTimeControl;
  color: LichessColor | "random";
  /** `in` for challenges to the user, `out` for theirs. */
  direction?: "in" | "out";
  declineReason?: string;
};

export type AccountEvent =
  | { type: "gameStart"; game: GameInfo }
  | { type: "gameFinish"; game: GameInfo }
  | { type: "challenge"; challenge: Challenge }
  | { type: "challengeCanceled"; challenge: Challenge }
  | { type: "challengeDeclined"; challenge: Challenge };

/** The time control of a new game, as Rust takes it. */
export type GameClock =
  | { type: "clock"; limitSeconds: number; incrementSeconds: number }
  | { type: "correspondence"; days: number }
  | { type: "unlimited" };

export type ColorChoice = "white" | "black" | "random";

/** A game against a person: a challenge to one player or a seek for anyone. */
export type GameRequest = { clock: GameClock; color: ColorChoice; rated: boolean };

export type GameAction =
  | "abort"
  | "resign"
  | "drawYes"
  | "drawNo"
  | "takebackYes"
  | "takebackNo"
  | "claimVictory"
  | "claimDraw";

// Streams get IDs here so they can be stopped; Rust keeps them by ID.
let nextStreamId = 1;

/** A stream that runs until Lichess closes it or `stop` is called. */
export type LichessStream = {
  /** Resolves with whether Lichess closed the stream (rather than `stop`); rejects on failure. */
  done: Promise<boolean>;
  stop: () => void;
};

function openStream<T>(
  command: string,
  args: Record<string, unknown>,
  onEvent: (event: T) => void,
): LichessStream {
  const streamId = nextStreamId++;
  const channel = new Channel<T>();
  channel.onmessage = onEvent;
  const done = invoke<boolean>(command, { ...args, streamId, onEvent: channel }).catch((reason) => {
    throw toLichessError(reason);
  });
  return { done, stop: () => void invoke("lichess_stream_stop", { streamId }).catch(() => {}) };
}

/** The account's events: games starting and ending, challenges coming and going. */
export const streamAccountEvents = (onEvent: (event: AccountEvent) => void) =>
  openStream("lichess_stream_events", {}, onEvent);

/** A game's events: the whole game first, then each change. */
export const streamGame = (gameId: string, onEvent: (event: GameStreamEvent) => void) =>
  openStream("lichess_stream_game", { gameId }, onEvent);

/** Seeks a game. Real-time seeks last until the stream ends; a game then starts. */
export function seekGame(request: GameRequest): LichessStream {
  const streamId = nextStreamId++;
  const done = invoke<boolean>("lichess_seek", { streamId, request }).catch((reason) => {
    throw toLichessError(reason);
  });
  return { done, stop: () => void invoke("lichess_stream_stop", { streamId }).catch(() => {}) };
}

const call = <T>(command: string, args: Record<string, unknown>) =>
  invoke<T>(command, args).catch((reason) => {
    throw toLichessError(reason);
  });

/** Starts a game against the Lichess AI and resolves with its ID. */
export async function challengeAi(game: {
  level: number;
  clock: GameClock;
  color: ColorChoice;
  fen?: string;
}): Promise<{ id: string; color?: Color }> {
  const created = await call<{ id: string; player?: LichessColor }>("lichess_challenge_ai", {
    game: { ...game, fen: game.fen ?? null },
  });
  return { id: created.id, color: created.player && toColor(created.player) };
}

export const challengePlayer = (username: string, request: GameRequest) =>
  call<Challenge>("lichess_challenge", { username, request });

export const respondToChallenge = (challengeId: string, action: "accept" | "decline" | "cancel") =>
  call<void>("lichess_challenge_respond", { challengeId, action });

export const playMove = (gameId: string, uci: string, offeringDraw = false) =>
  call<void>("lichess_game_move", { gameId, uci, offeringDraw });

export const gameAction = (gameId: string, action: GameAction) =>
  call<void>("lichess_game_action", { gameId, action });

export const sendChat = (gameId: string, text: string) =>
  call<void>("lichess_game_chat", { gameId, text });

export async function chatHistory(gameId: string): Promise<{ user: string; text: string }[]> {
  const lines = await call<unknown>("lichess_game_chat_history", { gameId });
  return Array.isArray(lines)
    ? lines.filter(
        (line): line is { user: string; text: string } =>
          !!line && typeof line.user === "string" && typeof line.text === "string",
      )
    : [];
}

/** Opens a lichess.org page in the browser; Rust refuses other sites. */
export const openLichessPage = (url: string) => invoke<void>("puzzles_open_game", { url });

export async function ongoingGames(): Promise<GameInfo[]> {
  const result = await call<{ nowPlaying?: GameInfo[] }>("lichess_playing", {});
  return result.nowPlaying ?? [];
}

/** Lichess writes the starting position as `startpos`. */
export function initialFen(full: Pick<GameFull, "initialFen">): string {
  return !full.initialFen || full.initialFen === "startpos" ? START_FEN : full.initialFen;
}

export const gameMoves = (state: Pick<GameState, "moves">): string[] =>
  state.moves.trim() === "" ? [] : state.moves.trim().split(/\s+/);

/** Whether the game is still on (or yet to start). */
export const inProgress = (status: GameStatus) => status === "created" || status === "started";

/** How a game Lichess reports as over ended, from its status and winner. */
export function lichessOutcome(state: Pick<GameState, "status" | "winner">): Outcome | undefined {
  const { status, winner } = state;
  if (inProgress(status)) return undefined;
  const result = winner === "white" ? "1-0" : winner === "black" ? "0-1" : "1/2-1/2";
  const termination: Termination =
    (
      {
        mate: "checkmate",
        resign: "resignation",
        stalemate: "stalemate",
        timeout: "abandonment",
        draw: "draw",
        outoftime: "timeout",
        cheat: "cheat",
        insufficientMaterialClaim: "insufficientMaterial",
        variantEnd: "other",
        unknownFinish: "other",
      } as Partial<Record<GameStatus, Termination>>
    )[status] ?? "other";
  if (status === "aborted" || status === "noStart") {
    return { result: "*", termination: "aborted" };
  }
  return { result, termination };
}

/** The player's name for the game header, e.g. `Lichess AI level 3`. */
export function playerName(player: GamePlayer): string {
  if (player.aiLevel) return `Lichess AI level ${player.aiLevel}`;
  const name = player.name ?? player.id ?? "Anonymous";
  return player.title ? `${player.title} ${name}` : name;
}

/** The side the signed-in user plays in a game, if they play in it. */
export function userColor(
  full: Pick<GameFull, "white" | "black">,
  username: string,
): Color | undefined {
  const id = username.toLowerCase();
  if (full.white.id?.toLowerCase() === id) return "w";
  if (full.black.id?.toLowerCase() === id) return "b";
  return undefined;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** PGN headers for a Lichess game. */
export function lichessHeaders(full: GameFull): [string, string][] {
  const date = new Date(full.createdAt);
  const speed = full.speed === "correspondence" ? "correspondence" : full.speed;
  const ai = full.white.aiLevel || full.black.aiLevel;
  const headers: [string, string][] = [
    [
      "Event",
      `${full.rated ? "Rated" : "Casual"} ${ai ? "game vs the Lichess AI" : `${speed} game`}`,
    ],
    ["Site", `https://lichess.org/${full.id}`],
    ["Date", `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`],
    ["White", playerName(full.white)],
    ["Black", playerName(full.black)],
    ["Result", "*"],
  ];
  for (const [side, player] of [
    ["White", full.white],
    ["Black", full.black],
  ] as const) {
    if (player.rating) headers.push([`${side}Elo`, String(player.rating)]);
    if (player.title) headers.push([`${side}Title`, player.title]);
  }
  headers.push([
    "TimeControl",
    full.clock
      ? `${Math.round(full.clock.initial / 1000)}+${Math.round(full.clock.increment / 1000)}`
      : full.daysPerTurn
        ? `1/${full.daysPerTurn * 86400}`
        : "-",
  ]);
  if (full.variant.key !== "standard") headers.push(["Variant", full.variant.name]);
  return headers;
}

/** A label for a time control such as `10+5`, `3 days` or `Unlimited`. */
export function timeControlName(control: ChallengeTimeControl | GameClock): string {
  if (control.type === "clock") {
    const [limit, increment] =
      "limit" in control
        ? [control.limit, control.increment]
        : [control.limitSeconds, control.incrementSeconds];
    const minutes = limit / 60;
    const shown =
      minutes === 0.25 ? "¼" : minutes === 0.5 ? "½" : minutes === 0.75 ? "¾" : String(minutes);
    return `${shown}+${increment}`;
  }
  if (control.type === "correspondence") {
    const days = "days" in control ? control.days : control.daysPerTurn;
    return days === 1 ? "1 day" : `${days} days`;
  }
  return "Unlimited";
}

/** Lichess's speed for a real-time clock: estimated game time is limit + 40 × increment. */
export function clockSpeed(limitSeconds: number, incrementSeconds: number): Speed {
  const estimate = limitSeconds + 40 * incrementSeconds;
  if (estimate < 30) return "ultraBullet";
  if (estimate < 180) return "bullet";
  if (estimate < 480) return "blitz";
  if (estimate < 1500) return "rapid";
  return "classical";
}

export const SPEED_NAMES: Record<Speed, string> = {
  ultraBullet: "UltraBullet",
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Rapid",
  classical: "Classical",
  correspondence: "Correspondence",
};

/** Which way a challenge goes, for older events without a `direction`. */
export function challengeDirection(challenge: Challenge, username: string): "in" | "out" {
  if (challenge.direction) return challenge.direction;
  return challenge.challenger.id === username.toLowerCase() ? "out" : "in";
}

/** Applies an event to the lists of challenges and ongoing games. */
export function applyAccountEvent(
  lists: { challenges: Challenge[]; games: GameInfo[] },
  event: AccountEvent,
): { challenges: Challenge[]; games: GameInfo[] } {
  switch (event.type) {
    case "gameStart":
      return {
        ...lists,
        games: [...lists.games.filter((g) => g.gameId !== event.game.gameId), event.game],
      };
    case "gameFinish":
      return { ...lists, games: lists.games.filter((g) => g.gameId !== event.game.gameId) };
    case "challenge":
      return {
        ...lists,
        challenges: [
          ...lists.challenges.filter((c) => c.id !== event.challenge.id),
          event.challenge,
        ],
      };
    case "challengeCanceled":
    case "challengeDeclined":
      return { ...lists, challenges: lists.challenges.filter((c) => c.id !== event.challenge.id) };
  }
}
