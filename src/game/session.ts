// A game open in a workspace tab: its move tree, headers and where the user is in it. Sessions
// outlive the tab's view, so switching tabs keeps moves, variations and the current position.

import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type Nag, toggleQualityNag } from "../chess/nag";
import { header, type PgnGame } from "../chess/pgn";
import { type MoveInput, makeMove } from "../chess/rules";
import {
  addMove,
  deleteNode,
  type GameTree,
  lineEnd,
  type MoveNode,
  makeMainline,
  type NodeId,
  pathTo,
  treeFromPgn,
  treeToPgn,
} from "../chess/tree";
import type { Accuracy } from "../data/mockGame";

export type Player = { name: string; rating?: string };

export type GameInfo = {
  white: Player;
  black: Player;
  eco?: string;
  opening?: string;
  accuracy?: Accuracy;
};

export type GameSession = ReturnType<typeof createGameSession>;

/** Creates a session for `game`. Call `dispose` when its tab closes. */
export function createGameSession(game: PgnGame, options: { accuracy?: Accuracy } = {}) {
  return createRoot((dispose) => {
    const [tree, setTree] = createStore<GameTree>(treeFromPgn(game));
    const [headers] = createSignal(game.headers);
    const [currentId, setCurrentId] = createSignal(tree.rootId);
    /**
     * The last node of the line shown in the toolbar and eval graph. It stays put while stepping
     * back, so stepping forward again retraces a variation instead of jumping to the main line.
     */
    const [lineEndId, setLineEndId] = createSignal(lineEnd(tree, tree.rootId));

    const node = (): MoveNode => tree.nodes[currentId()];
    const line = createMemo(() => pathTo(tree, lineEndId()));
    /** Index of the current node in `line()`; 0 is the starting position. */
    const index = () => node().ply - tree.nodes[tree.rootId].ply;
    const info = createMemo((): GameInfo => {
      const game = { headers: headers() };
      return {
        white: { name: header(game, "White") ?? "White", rating: header(game, "WhiteElo") },
        black: { name: header(game, "Black") ?? "Black", rating: header(game, "BlackElo") },
        eco: header(game, "ECO"),
        opening: header(game, "Opening"),
        accuracy: options.accuracy,
      };
    });

    /** Moves to a node, switching the shown line when the node is not on it. */
    const goTo = (id: NodeId) => {
      if (!tree.nodes[id]) return;
      batch(() => {
        if (!line().includes(id)) setLineEndId(lineEnd(tree, id));
        setCurrentId(id);
      });
    };

    /** Moves to the node at `target` (clamped) along the shown line. */
    const goToIndex = (target: number) => {
      const ids = line();
      setCurrentId(ids[Math.max(0, Math.min(ids.length - 1, target))]);
    };

    /** Moves to the previous (`-1`) or next (`1`) alternative to the current move. */
    const goToSibling = (direction: -1 | 1) => {
      const parentId = node().parent;
      if (parentId === undefined) return;
      const siblings = tree.nodes[parentId].children;
      const next = siblings[siblings.indexOf(currentId()) + direction];
      if (next) goTo(next);
    };

    /** Plays a move from the current position, following an existing move or adding a variation. */
    const play = (input: MoveInput) => {
      const result = makeMove(node().fen, input);
      if (!result) return;
      let id = currentId();
      setTree(
        produce((draft) => {
          id = addMove(draft, id, result);
        }),
      );
      goTo(id);
    };

    const toggleNag = (nag: Nag) => {
      const id = currentId();
      if (id === tree.rootId) return;
      setTree("nodes", id, "nags", (nags) => toggleQualityNag(nags, nag));
    };

    /** Deletes a move and everything after it. */
    const remove = (id: NodeId) => {
      const target = tree.nodes[id];
      if (target?.parent === undefined) return;
      const parentId = target.parent;
      const removed = pathTo(tree, currentId()).includes(id);
      const lineRemoved = line().includes(id);
      batch(() => {
        setTree(produce((draft) => deleteNode(draft, id)));
        if (removed) setCurrentId(parentId);
        if (lineRemoved) setLineEndId(lineEnd(tree, parentId));
      });
    };

    const promote = (id: NodeId) => {
      if (!tree.nodes[id]) return;
      setTree(produce((draft) => makeMainline(draft, id)));
    };

    return {
      tree,
      headers,
      info,
      currentId,
      node,
      line,
      index,
      goTo,
      goToIndex,
      goToSibling,
      next: () => goToIndex(index() + 1),
      prev: () => goToIndex(index() - 1),
      first: () => goToIndex(0),
      last: () => goToIndex(line().length - 1),
      play,
      toggleNag,
      remove,
      promote,
      toPgn: () => treeToPgn(tree, headers()),
      dispose,
    };
  });
}

/** A short title for a game, e.g. `Whiskers vs Mochi`. */
export function gameTitle(game: Pick<PgnGame, "headers">): string {
  const white = header(game, "White");
  const black = header(game, "Black");
  if (white || black) return `${white ?? "?"} vs ${black ?? "?"}`;
  return header(game, "Event") ?? "Untitled game";
}
