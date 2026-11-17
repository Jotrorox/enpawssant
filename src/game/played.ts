// What every game being played in a tab offers the board and the play card, whether the opponent
// is Stockfish on this machine or someone (or the AI) on Lichess.

import type { Accessor } from "solid-js";
import type { Color } from "../chess/board";
import type { Outcome } from "../chess/outcome";
import type { MoveInput } from "../chess/rules";
import type { NodeId } from "../chess/tree";

export type PlayedGame = {
  /** The side the user plays. */
  color: Accessor<Color>;
  outcome: Accessor<Outcome | undefined>;
  /** Whether the game is still on. */
  playing: Accessor<boolean>;
  /** Whose turn it is in the game. */
  turn: Accessor<Color>;
  /** The last position of the game, where play continues. */
  endId: Accessor<NodeId>;
  /** Time left for `side`, or `undefined` without a clock. */
  timeLeft: (side: Color) => number | undefined;
  /** The side whose clock is running. */
  clockRunning: Accessor<Color | undefined>;
  /** Whether the board should take the user's moves: on their turn, at the end of the game. */
  canMove: Accessor<boolean>;
  /** Plays the user's move at the end of the game. */
  move: (input: MoveInput) => void;
  dispose: () => void;
};

export const otherSide = (side: Color): Color => (side === "w" ? "b" : "w");
