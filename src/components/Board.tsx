import { createMemo, For, Show } from "solid-js";
import {
  type Color,
  displaySquares,
  isLightSquare,
  type Piece,
  parsePlacement,
  type Square,
  squareToCell,
} from "../chess/board";
import type { Arrow } from "../data/mockGame";
import { PawIcon } from "./Icons";

const OUTLINE_GLYPHS = { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" } as const;
const SOLID_GLYPHS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" } as const;
/** Forces text (not emoji) presentation, mainly for the black pawn on macOS. */
const TEXT_VS = "︎";

type BoardProps = {
  fen: string;
  orientation: Color;
  lastMove?: { from: Square; to: Square };
  arrows?: Arrow[];
};

export function Board(props: BoardProps) {
  const pieces = createMemo(() => parsePlacement(props.fen));
  const squares = createMemo(() => displaySquares(props.orientation));
  const bottomRank = () => (props.orientation === "w" ? "1" : "8");
  const leftFile = () => (props.orientation === "w" ? "a" : "h");

  return (
    <div class="relative pt-[30px]">
      <CatEars />
      <div class="relative rounded-[28px] bg-blush-300 p-[11px] shadow-[0_10px_30px_-12px_rgb(224_112_143/0.45)]">
        <div class="relative grid aspect-square grid-cols-8 grid-rows-8 overflow-hidden rounded-[18px] @container">
          <For each={squares()}>
            {(square) => (
              <BoardSquare
                square={square}
                piece={pieces().get(square)}
                highlight={
                  props.lastMove?.to === square
                    ? "to"
                    : props.lastMove?.from === square
                      ? "from"
                      : undefined
                }
                rankLabel={square[0] === leftFile() ? square[1] : undefined}
                fileLabel={square[1] === bottomRank() ? square[0] : undefined}
              />
            )}
          </For>
          <Show when={props.arrows?.length}>
            <Arrows arrows={props.arrows ?? []} orientation={props.orientation} />
          </Show>
        </div>
      </div>
    </div>
  );
}

function BoardSquare(props: {
  square: Square;
  piece?: Piece;
  highlight?: "from" | "to";
  rankLabel?: string;
  fileLabel?: string;
}) {
  const light = () => isLightSquare(props.square);
  const background = () => {
    if (props.highlight === "to") return "bg-peach";
    if (props.highlight === "from") return "bg-cream";
    return light() ? "bg-blush-100" : "bg-blush-400";
  };

  return (
    <div class={`relative flex items-center justify-center ${background()}`}>
      <Show when={props.rankLabel}>
        <span class="absolute top-[3%] left-[6%] font-mono text-[max(8px,1.7cqw)] font-bold leading-none text-plum/55">
          {props.rankLabel}
        </span>
      </Show>
      <Show when={props.fileLabel}>
        <span class="absolute right-[6%] bottom-[3%] font-mono text-[max(8px,1.7cqw)] font-bold leading-none text-plum/55">
          {props.fileLabel}
        </span>
      </Show>
      <Show when={props.highlight === "from" && !props.piece}>
        <PawIcon class="size-[32%] text-peach" />
      </Show>
      <Show when={props.piece}>{(piece) => <PieceGlyph piece={piece()} />}</Show>
    </div>
  );
}

function PieceGlyph(props: { piece: Piece }) {
  const label = () =>
    `${props.piece.color === "w" ? "White" : "Black"} ${
      { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" }[props.piece.type]
    }`;

  return (
    <span
      role="img"
      aria-label={label()}
      class="relative grid place-items-center font-chess text-[10.5cqw] leading-none text-plum drop-shadow-[0_1.5px_0_rgb(74_50_71/0.18)]"
    >
      <Show
        when={props.piece.color === "w"}
        fallback={<span>{SOLID_GLYPHS[props.piece.type] + TEXT_VS}</span>}
      >
        {/* A white silhouette under the outline glyph fills the piece's interior. */}
        <span class="col-start-1 row-start-1 text-white">
          {SOLID_GLYPHS[props.piece.type] + TEXT_VS}
        </span>
        <span class="col-start-1 row-start-1">{OUTLINE_GLYPHS[props.piece.type] + TEXT_VS}</span>
      </Show>
    </span>
  );
}

function Arrows(props: { arrows: Arrow[]; orientation: Color }) {
  return (
    <svg
      viewBox="0 0 8 8"
      class="pointer-events-none absolute inset-0 size-full"
      aria-hidden="true"
    >
      <For each={props.arrows}>
        {(arrow) => {
          const geometry = () => arrowGeometry(arrow, props.orientation);
          return (
            <g opacity={0.35 + 0.5 * arrow.strength} fill="var(--color-rose)">
              <line
                x1={geometry().x1}
                y1={geometry().y1}
                x2={geometry().shaftX}
                y2={geometry().shaftY}
                stroke="var(--color-rose)"
                stroke-width={0.08 + 0.1 * arrow.strength}
                stroke-linecap="round"
              />
              <polygon points={geometry().head} />
            </g>
          );
        }}
      </For>
    </svg>
  );
}

function arrowGeometry(arrow: Arrow, orientation: Color) {
  const [fx, fy] = squareToCell(arrow.from, orientation);
  const [tx, ty] = squareToCell(arrow.to, orientation);
  const x1 = fx + 0.5;
  const y1 = fy + 0.5;
  const x2 = tx + 0.5;
  const y2 = ty + 0.5;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  const headLength = 0.2 + 0.2 * arrow.strength;
  const headHalfWidth = headLength * 0.6;
  // The tip stops a little short of the target square's centre.
  const tipX = x2 - ux * 0.15;
  const tipY = y2 - uy * 0.15;
  const baseX = tipX - ux * headLength;
  const baseY = tipY - uy * headLength;
  const head = [
    [tipX, tipY],
    [baseX - uy * headHalfWidth, baseY + ux * headHalfWidth],
    [baseX + uy * headHalfWidth, baseY - ux * headHalfWidth],
  ]
    .map((point) => point.join(","))
    .join(" ");
  return { x1, y1, shaftX: baseX + ux * 0.02, shaftY: baseY + uy * 0.02, head };
}

function CatEars() {
  return (
    <div
      class="pointer-events-none absolute inset-x-[8%] top-0 flex justify-between"
      aria-hidden="true"
    >
      <Ear />
      <Ear />
    </div>
  );
}

function Ear() {
  return (
    <svg viewBox="0 0 56 36" class="h-9 w-14" aria-hidden="true">
      <path
        d="M0 36 C8 24 16 8 24 3 Q28 0 32 3 C40 8 48 24 56 36 Z"
        fill="var(--color-blush-300)"
      />
      <path
        d="M13 36 C18 28 22 18 26 15 Q28 13.5 30 15 C34 18 38 28 43 36 Z"
        fill="var(--color-blush-200)"
      />
    </svg>
  );
}
