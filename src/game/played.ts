// What every game being played in a tab offers the board and the play card, whether the opponent
// is Stockfish on this machine or someone (or the AI) on Lichess.

import { type Accessor, createEffect, createSignal, untrack } from "solid-js";
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
  /** Whether the user can queue a move: on the opponent's turn, at the end of the game. */
  canPremove: Accessor<boolean>;
  /** The queued move, played as soon as it's the user's turn (if it's legal then). */
  premove: Accessor<MoveInput | undefined>;
  /** Queues a move, or cancels the queued one. */
  setPremove: (move?: MoveInput) => void;
  dispose: () => void;
};

/**
 * A queued move for a game being played. It's played the moment the board takes the user's move
 * again, and dropped if it isn't legal then, if the user steps back from the end of the game or
 * when the game ends. Call inside the game's reactive root.
 */
export function createPremove(game: {
  canMove: Accessor<boolean>;
  canPremove: Accessor<boolean>;
  move: (input: MoveInput) => void;
}) {
  const [premove, setPremove] = createSignal<MoveInput>();
  createEffect(() => {
    const queued = premove();
    if (!queued) return;
    if (game.canMove()) {
      setPremove(undefined);
      untrack(() => game.move(queued));
    } else if (!game.canPremove()) {
      setPremove(undefined);
    }
  });
  return {
    premove,
    setPremove: (move?: MoveInput) => setPremove(move && game.canPremove() ? move : undefined),
  };
}

export const otherSide = (side: Color): Color => (side === "w" ? "b" : "w");
