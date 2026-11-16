import { createComputed, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { type Piece, parsePlacement, type Square, squareIndices } from "../chess/board";

/** How long captured pieces linger while fading out; matches the transitions in styles.css. */
const FADE_MS = 260;

export type PieceInstance = Piece & {
  id: number;
  square: Square;
  /** Colour and type the piece was created with; a change (promotion) replays the entry pop. */
  born: string;
  /** Fading out after being captured. */
  captured: boolean;
  /** Appeared after the first render, so it fades in. */
  fresh: boolean;
};

/** What changed between two positions, as seen by the pieces. */
export type PieceChange = {
  /** Pieces now on a different square (including promoted pawns), with their new square. */
  moved: PieceInstance[];
  /** Pieces that changed type: a promotion, or stepping back over one. */
  promoted: PieceInstance[];
  /** Pieces removed from the board, on the square they were taken on. */
  captured: PieceInstance[];
  /** Pieces that appeared out of nowhere, such as a capture undone by stepping back. */
  appeared: PieceInstance[];
};

/**
 * Tracks pieces across positions so each keeps a stable identity: pieces that move glide to their
 * new square, captured ones fade out and pieces that reappear (when stepping back) fade in.
 */
export function createPieceInstances(fen: () => string, onChange: (change: PieceChange) => void) {
  const [list, setList] = createStore<PieceInstance[]>([]);
  let nextId = 0;
  let firstRun = true;
  let fadeTimer: number | undefined;

  createComputed(
    on(fen, (fen) => {
      const placement = parsePlacement(fen);
      const current = list.map((p) => ({ ...p }));
      const fading = current.filter((p) => p.captured);
      const alive = current.filter((p) => !p.captured);
      const same = (a: Piece, b?: Piece) => b?.color === a.color && b.type === a.type;

      const stayed = alive.filter((p) => same(p, placement.get(p.square)));
      const occupied = new Set(stayed.map((p) => p.square));
      const missing = alive.filter((p) => !stayed.includes(p));
      const arrivals = [...placement].filter(([square]) => !occupied.has(square));

      const next: PieceInstance[] = stayed.map((p) => ({ ...p, fresh: false }));
      const moved: PieceInstance[] = [];
      const promoted: PieceInstance[] = [];
      const appeared: PieceInstance[] = [];
      const unmatched: [Square, Piece][] = [];
      const claim = (square: Square, piece: Piece, accept: (p: PieceInstance) => boolean) => {
        let best: PieceInstance | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of missing) {
          const d = distance(candidate.square, square);
          if (accept(candidate) && d < bestDistance) {
            best = candidate;
            bestDistance = d;
          }
        }
        if (!best) return false;
        missing.splice(missing.indexOf(best), 1);
        const instance = { ...best, ...piece, square, fresh: false };
        next.push(instance);
        moved.push(instance);
        if (instance.type !== best.type) promoted.push(instance);
        return true;
      };

      for (const [square, piece] of arrivals) {
        if (!claim(square, piece, (p) => same(p, piece))) unmatched.push([square, piece]);
      }
      // A promotion (or stepping back over one) turns a pawn into another piece next door.
      for (const [square, piece] of unmatched) {
        const promotedPawn = claim(
          square,
          piece,
          (p) =>
            p.color === piece.color &&
            (p.type === "p") !== (piece.type === "p") &&
            distance(p.square, square) <= 2,
        );
        if (!promotedPawn) {
          const instance = {
            id: nextId++,
            ...piece,
            square,
            born: `${piece.color}${piece.type}`,
            captured: false,
            fresh: !firstRun,
          };
          next.push(instance);
          appeared.push(instance);
        }
      }

      const captured = missing.map((p) => ({ ...p, captured: true, fresh: false }));
      setList(reconcile([...next, ...captured, ...fading], { key: "id" }));

      if (!firstRun && (arrivals.length > 0 || captured.length > 0)) {
        onChange({ moved, promoted, captured, appeared });
      }
      firstRun = false;

      if (captured.length > 0) {
        clearTimeout(fadeTimer);
        fadeTimer = window.setTimeout(
          () => setList((pieces) => pieces.filter((p) => !p.captured)),
          FADE_MS,
        );
      }
    }),
  );
  onCleanup(() => clearTimeout(fadeTimer));

  return list;
}

function distance(a: Square, b: Square): number {
  const [af, ar] = squareIndices(a);
  const [bf, br] = squareIndices(b);
  return (af - bf) ** 2 + (ar - br) ** 2;
}
