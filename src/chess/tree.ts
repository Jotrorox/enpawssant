// The move tree of a game. Every node is a position; its first child continues the line it is on
// and later children are variations. Nodes live in a flat record keyed by id so a Solid store can
// track each one, and the functions that change the tree mutate it in place (use them inside
// `produce`).

import { fenPlyIndex, type Square } from "./board";
import type { PgnGame, PgnMove } from "./pgn";

export type NodeId = string;

export type MoveNode = {
  id: NodeId;
  /** Missing only for the root. */
  parent?: NodeId;
  /** The first child continues the current line; the others are variations. */
  children: NodeId[];
  /** Half-moves since the start of the game, counting from a FEN's move number. */
  ply: number;
  /** Position after the move, or the starting position for the root. */
  fen: string;
  /** The move leading here; missing only for the root. */
  move?: { san: string; uci: string; from: Square; to: Square };
  nags: number[];
  startingComment?: string;
  comment?: string;
  /** The evaluation the game was imported with, e.g. from a lichess `[%eval]`. */
  eval?: PgnMove["eval"];
};

export type GameTree = {
  rootId: NodeId;
  nodes: Record<NodeId, MoveNode>;
  /** Counter for new node ids. */
  nextId: number;
};

/** The move that was just played: what `addMove` needs to extend the tree. */
export type NewMove = { san: string; uci: string; fen: string };

export function emptyTree(startFen: string): GameTree {
  const rootId = "n0";
  const root: MoveNode = {
    id: rootId,
    children: [],
    ply: fenPlyIndex(startFen),
    fen: startFen,
    nags: [],
  };
  return { rootId, nodes: { [rootId]: root }, nextId: 1 };
}

function createNode(tree: GameTree, parentId: NodeId, move: NewMove): MoveNode {
  const parent = tree.nodes[parentId];
  const id = `n${tree.nextId++}`;
  const node: MoveNode = {
    id,
    parent: parentId,
    children: [],
    ply: parent.ply + 1,
    fen: move.fen,
    move: {
      san: move.san,
      uci: move.uci,
      from: move.uci.slice(0, 2),
      to: move.uci.slice(2, 4),
    },
    nags: [],
  };
  tree.nodes[id] = node;
  parent.children.push(id);
  return node;
}

/** Plays a move after `parentId`, reusing the child that already has it. Returns its id. */
export function addMove(tree: GameTree, parentId: NodeId, move: NewMove): NodeId {
  const existing = tree.nodes[parentId].children.find(
    (id) => tree.nodes[id].move?.uci === move.uci,
  );
  return existing ?? createNode(tree, parentId, move).id;
}

/** Removes a node and everything after it. */
export function deleteNode(tree: GameTree, id: NodeId) {
  const node = tree.nodes[id];
  if (node.parent === undefined) return;
  const siblings = tree.nodes[node.parent].children;
  siblings.splice(siblings.indexOf(id), 1);
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop() as NodeId;
    stack.push(...tree.nodes[next].children);
    delete tree.nodes[next];
  }
}

/** Makes the line through `id` the main line at every branch on the way to it. */
export function makeMainline(tree: GameTree, id: NodeId) {
  let node = tree.nodes[id];
  while (node.parent !== undefined) {
    const siblings = tree.nodes[node.parent].children;
    const index = siblings.indexOf(node.id);
    if (index > 0) {
      siblings.splice(index, 1);
      siblings.unshift(node.id);
    }
    node = tree.nodes[node.parent];
  }
}

/** Ids from the root to `id`, both included. */
export function pathTo(tree: GameTree, id: NodeId): NodeId[] {
  const path: NodeId[] = [];
  for (let node: MoveNode | undefined = tree.nodes[id]; node; ) {
    path.push(node.id);
    node = node.parent === undefined ? undefined : tree.nodes[node.parent];
  }
  return path.reverse();
}

/** The last node reached by following first children from `id`. */
export function lineEnd(tree: GameTree, id: NodeId): NodeId {
  let node = tree.nodes[id];
  while (node.children.length > 0) node = tree.nodes[node.children[0]];
  return node.id;
}

/** Whether `id` is on the main line, i.e. every move on the way to it is a first child. */
export function isMainline(tree: GameTree, id: NodeId): boolean {
  let node = tree.nodes[id];
  while (node.parent !== undefined) {
    if (tree.nodes[node.parent].children[0] !== node.id) return false;
    node = tree.nodes[node.parent];
  }
  return true;
}

/** Number of variations, i.e. moves that are not the first choice in their position. */
export function variationCount(tree: GameTree): number {
  return Object.values(tree.nodes).reduce(
    (count, node) => count + Math.max(0, node.children.length - 1),
    0,
  );
}

export function treeFromPgn(game: Pick<PgnGame, "startFen" | "moves">): GameTree {
  const tree = emptyTree(game.startFen);
  // Iterate along lines and only recurse into variations, so long games don't grow the stack.
  const addLine = (parentId: NodeId, line: PgnMove[]) => {
    let parent = parentId;
    for (const move of line) {
      const node = createNode(tree, parent, move);
      node.nags = move.nags ?? [];
      node.startingComment = move.startingComment;
      node.comment = move.comment;
      node.eval = move.eval;
      for (const variation of move.variations ?? []) addLine(parent, variation);
      parent = node.id;
    }
  };
  addLine(tree.rootId, game.moves);
  return tree;
}

export function treeToPgn(tree: GameTree, headers: [string, string][]): PgnGame {
  const toMove = (node: MoveNode): PgnMove => ({
    san: node.move?.san ?? "",
    uci: node.move?.uci ?? "",
    fen: node.fen,
    nags: node.nags,
    startingComment: node.startingComment,
    comment: node.comment,
    eval: node.eval,
  });
  /** The line after `parentId`, starting with `firstId` (a variation) or the main move. */
  const line = (parentId: NodeId, firstId?: NodeId): PgnMove[] => {
    const moves: PgnMove[] = [];
    let parent = tree.nodes[parentId];
    let first = firstId;
    while (parent.children.length > 0) {
      const node = tree.nodes[first ?? parent.children[0]];
      const move = toMove(node);
      // A variation's own alternatives are written by the line that branches into it.
      if (first === undefined && parent.children.length > 1) {
        move.variations = parent.children.slice(1).map((id) => line(parent.id, id));
      }
      moves.push(move);
      parent = node;
      first = undefined;
    }
    return moves;
  };
  const root = tree.nodes[tree.rootId];
  return { headers, startFen: root.fen, moves: line(root.id) };
}
