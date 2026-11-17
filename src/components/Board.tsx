import {
  batch,
  createComputed,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { type Shape, type ShapeColor, toggleShape } from "../chess/annotations";
import {
  type Arrow,
  type Color,
  cellToSquare,
  displaySquares,
  isLightSquare,
  type Piece,
  type PieceType,
  type Square,
  squareToCell,
} from "../chess/board";
import { PIECE_NAMES, pieceLabel, pieceUrl } from "../chess/pieces";
import {
  checkSquare,
  hasLegalMoves,
  isPromotion,
  legalDests,
  type MoveInput,
  parseFen,
  premoveDests,
  squareIndex,
} from "../chess/rules";
import { playSound, primeAudio, type SoundKind } from "../chess/sound";
import {
  burst,
  CAPTURE_COLORS,
  CONFETTI_COLORS,
  prefersReducedMotion,
  ripple,
  SPARKLE_COLORS,
  shake,
  squash,
  wiggle,
} from "./boardEffects";
import { PawIcon } from "./Icons";
import { createPieceInstances, type PieceChange, type PieceInstance } from "./pieceInstances";

/** Pointer travel in px before pressing a piece turns into dragging it. */
const DRAG_THRESHOLD = 4;
/**
 * When a moved piece visually lands, in ms: gliding pieces are front-loaded (ease-out) and arrive
 * about halfway through the 220ms glide; dropped pieces are already on their square.
 */
const GLIDE_LANDING_MS = 110;
const DROP_LANDING_MS = 25;

const SHAPE_COLORS: Record<ShapeColor, string> = {
  green: "var(--color-nag-good)",
  red: "var(--color-rose-strong)",
  blue: "var(--color-nag-interesting)",
  yellow: "var(--color-nag-dubious)",
};

type Drag = {
  pieceId: number;
  from: Square;
  /** Pointer position relative to the board, in px. */
  x: number;
  y: number;
  /** Size of one square in px. */
  size: number;
  startX: number;
  startY: number;
  /** False until the pointer has travelled far enough to count as a drag rather than a click. */
  active: boolean;
  /** Whether the piece was already selected before this press; clicking it again deselects it. */
  wasSelected: boolean;
};

type BoardProps = {
  fen: string;
  orientation: Color;
  lastMove?: { from: Square; to: Square };
  arrows?: Arrow[];
  /** Called with each legal move the user makes. Without it the board is read-only. */
  onMove?: (move: MoveInput) => void;
  /**
   * Premoves while the opponent is to move: `color`'s pieces can be moved anywhere they might be
   * able to go after the opponent's move, and `onSet` is called with that move (promoting to a
   * queen), or with nothing to cancel the queued one, `current`.
   */
  premove?: {
    color: Color;
    enabled: boolean;
    current?: MoveInput;
    onSet: (move?: MoveInput) => void;
  };
  /** Play a sound when the position changes. */
  sound?: boolean;
  /**
   * Circles and arrows drawn with the right mouse button. With `onShapesChange` the board shows
   * these and reports changes instead of keeping its own, which it clears on every move.
   */
  shapes?: Shape[];
  onShapesChange?: (shapes: Shape[]) => void;
};

export function Board(props: BoardProps) {
  const position = createMemo(() => parseFen(props.fen));
  /** Whether the board takes premoves rather than moves right now. */
  const premoving = () => !props.onMove && !!props.premove?.enabled;
  const dests = createMemo(() => {
    if (props.onMove) return legalDests(position());
    const premove = props.premove;
    if (premove?.enabled) return premoveDests(position(), premove.color);
    return new Map<Square, Square[]>();
  });
  /** The squares of the queued premove, tinted until it's played. */
  const premoveSquares = () => {
    const current = props.premove?.current;
    return current ? [current.from, current.to] : [];
  };
  const cancelPremove = () => {
    if (props.premove?.current) props.premove.onSet(undefined);
  };
  const squares = createMemo(() => displaySquares(props.orientation));
  const bottomRank = () => (props.orientation === "w" ? "1" : "8");
  const leftFile = () => (props.orientation === "w" ? "a" : "h");

  const [selected, setSelected] = createSignal<Square>();
  const [drag, setDrag] = createSignal<Drag>();
  const [promotion, setPromotion] = createSignal<{ from: Square; to: Square }>();
  const [ownShapes, setOwnShapes] = createSignal<Shape[]>([]);
  const controlled = () => props.onShapesChange !== undefined;
  const shapes = () => (controlled() ? (props.shapes ?? []) : ownShapes());
  const setShapes = (next: Shape[]) => {
    if (props.onShapesChange) props.onShapesChange(next);
    else setOwnShapes(next);
  };
  const [drawing, setDrawing] = createSignal<Shape>();
  /** Square under the pointer, for hover feedback. */
  const [pointerSquare, setPointerSquare] = createSignal<Square>();

  const check = createMemo(() => checkSquare(position()));
  /** The checkmated king's square, if any. */
  const mateSquare = createMemo(() => {
    const square = check();
    return square && !hasLegalMoves(position()) ? square : undefined;
  });

  let boardEl!: HTMLDivElement;
  let underlay: HTMLDivElement | undefined;
  let overlay: HTMLDivElement | undefined;
  /** Each piece's effects wrapper, for squash, wiggle and shake animations. */
  const fxElements = new Map<number, HTMLElement>();
  /** Set when the next position change comes from a drop, so effects fire without waiting. */
  let landedByDrop = false;

  const cellOf = (square: Square) => squareToCell(square, props.orientation);

  const onPositionChange = (change: PieceChange) => {
    const landing = landedByDrop ? DROP_LANDING_MS : GLIDE_LANDING_MS;
    landedByDrop = false;
    const mate = mateSquare();
    const checked = check();
    // A single move (or a single step back) rather than a jump across the game.
    const single =
      change.moved.length > 0 &&
      change.moved.length <= 2 &&
      change.captured.length <= 1 &&
      change.appeared.length <= 1;

    if (props.sound) {
      let kind: SoundKind = "move";
      if (mate) kind = "mate";
      else if (change.promoted.length > 0) kind = "promote";
      else if (change.captured.length > 0) kind = "capture";
      else if (single && change.moved.length === 2) kind = "castle";
      playSound(kind, landing / 1000);
      if (checked && !mate) playSound("check", landing / 1000);
    }

    if (!single || prefersReducedMotion()) return;
    for (const piece of change.moved) squash(fxElements.get(piece.id), landing);
    const mover = change.moved.find((p) => p.type === "k") ?? change.moved[0];
    ripple(underlay, cellOf(mover.square), landing);
    for (const piece of change.captured) {
      burst(overlay, cellOf(piece.square), { delay: landing, colors: CAPTURE_COLORS, count: 12 });
    }
    for (const piece of change.promoted) {
      burst(overlay, cellOf(piece.square), {
        delay: landing,
        colors: SPARKLE_COLORS,
        count: 14,
        sparkles: true,
      });
    }
    if (checked && !mate) {
      const king = pieces.find((p) => !p.captured && p.square === checked);
      if (king) wiggle(fxElements.get(king.id), landing + 40);
    }
    if (mate) {
      burst(overlay, cellOf(mate), {
        delay: landing + 520,
        colors: CONFETTI_COLORS,
        count: 26,
        spread: 1.7,
        sparkles: true,
      });
    }
  };

  const pieces = createPieceInstances(() => props.fen, onPositionChange);

  // Any pending interaction belongs to the old position.
  createComputed(
    on(
      () => props.fen,
      () =>
        batch(() => {
          setSelected(undefined);
          setDrag(undefined);
          setPromotion(undefined);
          setOwnShapes([]);
          setDrawing(undefined);
        }),
      { defer: true },
    ),
  );

  const selectedDests = createMemo(() => {
    const square = selected();
    return square ? (dests().get(square) ?? []) : [];
  });

  const movable = (square: Square) => dests().has(square);
  const canMove = (from: Square, to: Square) => dests().get(from)?.includes(to) ?? false;

  const locate = (event: PointerEvent) => {
    const rect = boardEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const size = rect.width / 8;
    const col = Math.floor(x / size);
    const row = Math.floor(y / size);
    const inside = col >= 0 && col < 8 && row >= 0 && row < 8;
    return { x, y, size, square: inside ? cellToSquare(col, row, props.orientation) : undefined };
  };

  const play = (from: Square, to: Square) => {
    setSelected(undefined);
    // Premoves promote to a queen; there is no time to ask.
    if (premoving()) props.premove?.onSet({ from, to });
    else if (isPromotion(position(), from, to)) setPromotion({ from, to });
    else props.onMove?.({ from, to });
  };

  const choosePromotion = (type: PieceType) => {
    const pending = promotion();
    if (!pending) return;
    setPromotion(undefined);
    // The pawn is already waiting on the promotion square.
    landedByDrop = true;
    props.onMove?.({ ...pending, promotion: type });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (promotion() || drag() || drawing()) return;
    const at = locate(event);
    if (!at.square) return;
    primeAudio();
    landedByDrop = false;

    if (event.button === 2) {
      cancelPremove();
      boardEl.setPointerCapture(event.pointerId);
      setDrawing({ from: at.square, to: at.square, color: shapeColor(event) });
      return;
    }
    if (event.button !== 0) return;

    // Shapes the board keeps itself are scribbles that a click wipes; stored ones stay put.
    if (!controlled()) setOwnShapes([]);
    const current = selected();
    if (current && canMove(current, at.square)) {
      play(current, at.square);
      return;
    }
    const piece = movable(at.square)
      ? pieces.find((p) => !p.captured && p.square === at.square)
      : undefined;
    if (!piece) {
      setSelected(undefined);
      cancelPremove();
      return;
    }
    event.preventDefault();
    boardEl.setPointerCapture(event.pointerId);
    setSelected(at.square);
    setDrag({
      pieceId: piece.id,
      from: at.square,
      x: at.x,
      y: at.y,
      size: at.size,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      wasSelected: current === at.square,
    });
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = drag();
    const sketch = drawing();
    const at = locate(event);
    setPointerSquare(at.square);
    if (sketch) {
      if (at.square && at.square !== sketch.to) setDrawing({ ...sketch, to: at.square });
    } else if (current) {
      const active =
        current.active ||
        Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > DRAG_THRESHOLD;
      if (active && !current.active && props.sound) playSound("pickup");
      setDrag({ ...current, x: at.x, y: at.y, active });
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    const sketch = drawing();
    if (sketch) {
      setDrawing(undefined);
      setShapes(toggleShape(shapes(), sketch));
      return;
    }
    const current = drag();
    if (!current) return;
    const target = locate(event).square;
    // Clearing the drag and playing the move in one batch lets the piece glide from the pointer
    // straight onto its new square (or back home when the drop was illegal).
    const legal = target !== undefined && canMove(current.from, target);
    batch(() => {
      setDrag(undefined);
      if (current.active) {
        if (legal) {
          // A premove leaves the position as it is, so the piece glides back home.
          if (!premoving()) landedByDrop = true;
          play(current.from, target);
        }
      } else if (current.wasSelected) {
        setSelected(undefined);
      }
    });
    // Dropped somewhere it can't go: it slides home and shakes its head.
    if (current.active && !legal && target && target !== current.from) {
      if (props.sound) playSound("illegal", 0.12);
      if (!prefersReducedMotion()) shake(fxElements.get(current.pieceId), 170);
    }
  };

  const onPointerCancel = () => {
    setDrag(undefined);
    setDrawing(undefined);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    setPromotion(undefined);
    setSelected(undefined);
    cancelPremove();
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  /** Where a piece is drawn: a pawn waiting for its promotion choice already sits on the target. */
  const shownSquare = (piece: PieceInstance) => {
    const pending = promotion();
    return pending && !piece.captured && piece.square === pending.from ? pending.to : piece.square;
  };
  const concealed = (piece: PieceInstance) => {
    const pending = promotion();
    return !!pending && !piece.captured && piece.square === pending.to;
  };

  /** Move hints ripple outwards from the selected piece. */
  const hintDelay = (square: Square) => {
    const from = selected();
    if (!from) return 0;
    const [fx, fy] = squareToCell(from, "w");
    const [tx, ty] = squareToCell(square, "w");
    return Math.min(180, Math.round(Math.hypot(tx - fx, ty - fy) * 24));
  };

  /** Pieces rise a little under the pointer (when movable) and while selected. */
  const lifted = (piece: PieceInstance) => {
    if (drag()?.active || piece.captured) return false;
    if (selected() === piece.square) return true;
    return pointerSquare() === piece.square && movable(piece.square) && !selected();
  };

  const cursor = () => {
    if (drag()?.active) return "cursor-grabbing";
    const square = pointerSquare();
    if (!square || promotion()) return "";
    if (selectedDests().includes(square)) return "cursor-pointer";
    return movable(square) ? "cursor-grab" : "";
  };

  return (
    <div class="board-surface relative pt-[30px]">
      <CatEars />
      <div class="relative rounded-[28px] bg-(--board-frame) p-[11px] shadow-[0_10px_30px_-12px_rgb(224_112_143/0.45)]">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-driven board; moves are also reachable from the notation and toolbar. */}
        <div
          ref={boardEl}
          class={`@container relative aspect-square touch-none ${cursor()}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => setPointerSquare(undefined)}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div class="grid size-full grid-cols-8 grid-rows-8 overflow-hidden rounded-[18px]">
            <For each={squares()}>
              {(square) => {
                const occupant = () => position().board[squareIndex(square)];
                const dragging = () => drag()?.active === true && drag()?.from === square;
                return (
                  <BoardSquare
                    square={square}
                    lastMove={
                      props.lastMove?.to === square
                        ? "to"
                        : props.lastMove?.from === square
                          ? "from"
                          : undefined
                    }
                    selected={selected() === square}
                    premove={premoveSquares().includes(square)}
                    check={check() === square}
                    hint={
                      selectedDests().includes(square)
                        ? occupant()
                          ? "capture"
                          : "move"
                        : undefined
                    }
                    hovered={pointerSquare() === square && selectedDests().includes(square)}
                    hintDelay={hintDelay(square)}
                    empty={!occupant()}
                    ghost={dragging() ? occupant() : undefined}
                    rankLabel={square[0] === leftFile() ? square[1] : undefined}
                    fileLabel={square[1] === bottomRank() ? square[0] : undefined}
                  />
                );
              }}
            </For>
          </div>

          <div
            ref={underlay}
            class="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[18px]"
          />

          <div class="pointer-events-none absolute inset-0">
            <For each={pieces}>
              {(piece) => {
                const dragging = () => drag()?.active === true && drag()?.pieceId === piece.id;
                const transform = () => {
                  const current = drag();
                  if (current?.active && current.pieceId === piece.id) {
                    const x = (current.x / current.size - 0.5) * 100;
                    const y = (current.y / current.size - 0.5) * 100;
                    return `translate(${x}%, ${y}%)`;
                  }
                  const [x, y] = squareToCell(shownSquare(piece), props.orientation);
                  return `translate(${x * 100}%, ${y * 100}%)`;
                };
                const layer = () => {
                  if (dragging()) return 30;
                  if (piece.captured) return 1;
                  // The piece that just moved glides over everything else.
                  return props.lastMove?.to === piece.square ? 3 : 2;
                };
                return (
                  <div
                    class="board-piece absolute top-0 left-0 size-[12.5%]"
                    classList={{
                      dragging: dragging(),
                      captured: piece.captured,
                      concealed: concealed(piece),
                      lifted: lifted(piece),
                    }}
                    style={{ transform: transform(), "z-index": layer() }}
                  >
                    <div
                      ref={(el) => {
                        fxElements.set(piece.id, el);
                        onCleanup(() => fxElements.delete(piece.id));
                      }}
                      class="board-piece-fx size-full"
                      classList={{ toppled: !piece.captured && mateSquare() === piece.square }}
                    >
                      <Show when={`${piece.color}${piece.type}`} keyed>
                        {(kind) => (
                          <div
                            role="img"
                            aria-label={pieceLabel(piece)}
                            class="board-piece-image size-full"
                            classList={{ "board-piece-enter": piece.fresh || kind !== piece.born }}
                            style={{ "background-image": `url("${pieceUrl(piece)}")` }}
                          />
                        )}
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>

          <Shapes
            arrows={props.arrows ?? []}
            shapes={shapes()}
            drawing={drawing()}
            orientation={props.orientation}
          />

          <div ref={overlay} class="pointer-events-none absolute inset-0 z-[25]" />

          <Show when={promotion()}>
            {(pending) => (
              <PromotionPicker
                square={pending().to}
                color={position().turn}
                orientation={props.orientation}
                onPick={choosePromotion}
                onCancel={() => setPromotion(undefined)}
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

function shapeColor(event: PointerEvent): ShapeColor {
  if (event.shiftKey && event.altKey) return "yellow";
  if (event.shiftKey) return "red";
  if (event.altKey) return "blue";
  return "green";
}

function BoardSquare(props: {
  square: Square;
  lastMove?: "from" | "to";
  selected: boolean;
  /** Part of the queued premove. */
  premove: boolean;
  check: boolean;
  hint?: "move" | "capture";
  hovered: boolean;
  hintDelay: number;
  empty: boolean;
  ghost?: Piece;
  rankLabel?: string;
  fileLabel?: string;
}) {
  const light = () => isLightSquare(props.square);
  const background = () => {
    if (props.lastMove === "to") return "bg-(--board-to)";
    if (props.lastMove === "from") return "bg-(--board-from)";
    return light() ? "bg-(--board-light)" : "bg-(--board-dark)";
  };
  const fade = (visible: boolean) => (visible ? "opacity-100" : "opacity-0");

  return (
    <div class={`relative transition-colors duration-200 ${background()}`}>
      <span
        class={`absolute inset-0 bg-rose/30 transition-opacity duration-150 ${fade(props.selected)}`}
      />
      <span
        class={`absolute inset-0 bg-nag-interesting/45 transition-opacity duration-150 ${fade(props.premove)}`}
      />
      <span
        class={`board-check absolute inset-0 transition-opacity duration-200 ${fade(props.check)}`}
      />
      <span
        class={`absolute inset-0 bg-white/35 shadow-[inset_0_0_0_0.55cqw_var(--color-rose)] transition-opacity duration-100 ${fade(props.hovered)}`}
      />
      <Show when={props.lastMove === "from" && props.empty}>
        <span class="absolute inset-0 grid place-items-center">
          <PawIcon class="size-[32%] text-(--board-to)" />
        </span>
      </Show>
      <Show when={props.ghost}>
        {(piece) => (
          <span
            class="board-piece-image absolute inset-0 opacity-30"
            style={{ "background-image": `url("${pieceUrl(piece())}")` }}
          />
        )}
      </Show>
      <Show when={props.hint === "move" && !props.hovered}>
        <span class="absolute inset-0 grid place-items-center">
          <span
            class="board-hint size-[30%] rounded-full bg-plum/25"
            style={{ "animation-delay": `${props.hintDelay}ms` }}
          />
        </span>
      </Show>
      <Show when={props.hint === "capture"}>
        <span
          class="board-hint absolute inset-0 bg-[radial-gradient(transparent_0_74%,rgb(74_50_71/0.25)_76%)]"
          style={{ "animation-delay": `${props.hintDelay}ms` }}
        />
      </Show>
      <Show when={props.rankLabel}>
        <span
          class={`absolute top-[3%] left-[6%] font-mono text-[max(8px,1.7cqw)] font-bold leading-none ${light() ? "text-(--board-coord)" : "text-(--board-coord-on-dark)"}`}
        >
          {props.rankLabel}
        </span>
      </Show>
      <Show when={props.fileLabel}>
        <span
          class={`absolute right-[6%] bottom-[3%] font-mono text-[max(8px,1.7cqw)] font-bold leading-none ${light() ? "text-(--board-coord)" : "text-(--board-coord-on-dark)"}`}
        >
          {props.fileLabel}
        </span>
      </Show>
    </div>
  );
}

const PROMOTION_CHOICES: PieceType[] = ["q", "n", "r", "b"];

function PromotionPicker(props: {
  square: Square;
  color: Color;
  orientation: Color;
  onPick: (type: PieceType) => void;
  onCancel: () => void;
}) {
  const cell = () => squareToCell(props.square, props.orientation);
  // Choices stack from the promotion square towards the middle of the board.
  const fromTop = () => cell()[1] === 0;

  return (
    <div
      class="board-fade-in absolute inset-0 z-40 rounded-[18px] bg-plum/30 backdrop-blur-[1.5px]"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <For each={PROMOTION_CHOICES}>
        {(type, index) => (
          <button
            type="button"
            aria-label={`Promote to ${PIECE_NAMES[type]}`}
            title={`Promote to ${PIECE_NAMES[type]}`}
            class="board-promo group absolute grid size-[12.5%] place-items-center"
            style={{
              left: `${cell()[0] * 12.5}%`,
              top: `${(fromTop() ? index() : 7 - index()) * 12.5}%`,
              "animation-delay": `${index() * 35}ms`,
            }}
            onClick={() => props.onPick(type)}
          >
            <span class="grid size-[88%] place-items-center rounded-full bg-white shadow-[0_6px_16px_-6px_rgb(74_50_71/0.5)] transition-[transform,background-color] duration-150 group-hover:scale-[1.07] group-hover:bg-blush-100 group-active:scale-95">
              <span
                class="board-piece-image size-[84%]"
                style={{ "background-image": `url("${pieceUrl({ color: props.color, type })}")` }}
              />
            </span>
          </button>
        )}
      </For>
    </div>
  );
}

function Shapes(props: { arrows: Arrow[]; shapes: Shape[]; drawing?: Shape; orientation: Color }) {
  return (
    <svg
      viewBox="0 0 8 8"
      class="pointer-events-none absolute inset-0 z-20 size-full overflow-visible"
      aria-hidden="true"
    >
      <For each={props.arrows}>
        {(arrow) => (
          // An arrow that starts and ends on the same square marks that square, e.g. as a hint.
          <Show
            when={arrow.from !== arrow.to}
            fallback={
              <circle
                cx={squareToCell(arrow.from, props.orientation)[0] + 0.5}
                cy={squareToCell(arrow.from, props.orientation)[1] + 0.5}
                r={0.45}
                fill="none"
                stroke="var(--color-rose)"
                stroke-width={0.08}
                opacity={0.35 + 0.5 * arrow.strength}
              />
            }
          >
            <ArrowShape
              from={arrow.from}
              to={arrow.to}
              strength={arrow.strength}
              color="var(--color-rose)"
              opacity={0.35 + 0.5 * arrow.strength}
              orientation={props.orientation}
            />
          </Show>
        )}
      </For>
      <For each={props.shapes}>
        {(shape) => <UserShape shape={shape} opacity={0.8} orientation={props.orientation} />}
      </For>
      <Show when={props.drawing}>
        {(shape) => <UserShape shape={shape()} opacity={0.5} orientation={props.orientation} />}
      </Show>
    </svg>
  );
}

function UserShape(props: { shape: Shape; opacity: number; orientation: Color }) {
  const color = () => SHAPE_COLORS[props.shape.color];
  return (
    <Show
      when={props.shape.from !== props.shape.to}
      fallback={
        <circle
          cx={squareToCell(props.shape.from, props.orientation)[0] + 0.5}
          cy={squareToCell(props.shape.from, props.orientation)[1] + 0.5}
          r={0.45}
          fill="none"
          stroke={color()}
          stroke-width={0.07}
          opacity={props.opacity}
        />
      }
    >
      <ArrowShape
        from={props.shape.from}
        to={props.shape.to}
        strength={0.8}
        color={color()}
        opacity={props.opacity}
        orientation={props.orientation}
      />
    </Show>
  );
}

function ArrowShape(props: {
  from: Square;
  to: Square;
  strength: number;
  color: string;
  opacity: number;
  orientation: Color;
}) {
  const geometry = () => arrowGeometry(props.from, props.to, props.strength, props.orientation);
  return (
    <g opacity={props.opacity} fill={props.color}>
      <line
        x1={geometry().x1}
        y1={geometry().y1}
        x2={geometry().shaftX}
        y2={geometry().shaftY}
        stroke={props.color}
        stroke-width={0.08 + 0.1 * props.strength}
        stroke-linecap="round"
      />
      <polygon points={geometry().head} />
    </g>
  );
}

function arrowGeometry(from: Square, to: Square, strength: number, orientation: Color) {
  const [fx, fy] = squareToCell(from, orientation);
  const [tx, ty] = squareToCell(to, orientation);
  const x1 = fx + 0.5;
  const y1 = fy + 0.5;
  const x2 = tx + 0.5;
  const y2 = ty + 0.5;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  const headLength = 0.2 + 0.2 * strength;
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
      <path d="M0 36 C8 24 16 8 24 3 Q28 0 32 3 C40 8 48 24 56 36 Z" fill="var(--board-frame)" />
      <path
        d="M13 36 C18 28 22 18 26 15 Q28 13.5 30 15 C34 18 38 28 43 36 Z"
        fill="var(--board-ear)"
      />
    </svg>
  );
}
