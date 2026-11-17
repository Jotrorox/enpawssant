// The board editor: set up any position by placing pieces, or paste a FEN, then analyse it.

import { batch, createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import {
  type Color,
  cellToSquare,
  displaySquares,
  isLightSquare,
  type Piece,
  type PieceType,
  type Square,
  START_FEN,
} from "../chess/board";
import { PIECE_NAMES, pieceLabel, pieceUrl } from "../chess/pieces";
import { type Position, parseFen, squareIndex, squareName, toFen } from "../chess/rules";
import {
  checkPosition,
  enPassantSquares,
  looksLikeFen,
  possibleCastling,
  tidyPosition,
} from "../chess/setup";
import { CheckIcon, EraserIcon, FlipIcon, HandIcon } from "./Icons";
import { INPUT, Modal, PRIMARY_BUTTON, SECONDARY_BUTTON, Segmented } from "./ui";

type Tool = { kind: "move" } | { kind: "erase" } | { kind: "piece"; piece: Piece };

type Drag = {
  piece: Piece;
  /** Where the piece was picked up; missing when it comes from the palette. */
  from?: Square;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Size of a square in px, for the piece under the pointer. */
  size: number;
  moved: boolean;
};

/** Rust's verdict on the position `input`: its cleaned-up FEN, or why it can't be used. */
type Check = { input: string } & ({ ok: true; fen: string } | { ok: false; message: string });

const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";
const PALETTE: PieceType[] = ["k", "q", "r", "b", "n", "p"];
const CASTLING_CHOICES = [
  { right: "K", label: "O-O", color: "w" },
  { right: "Q", label: "O-O-O", color: "w" },
  { right: "k", label: "O-O", color: "b" },
  { right: "q", label: "O-O-O", color: "b" },
] as const;
const DRAG_THRESHOLD = 4;

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));
const samePiece = (a?: Piece, b?: Piece) => a?.color === b?.color && a?.type === b?.type;

type BoardEditorProps = {
  open: boolean;
  /** The position to start from. */
  fen: string;
  orientation: Color;
  onClose: () => void;
  /** Called with the checked position and how the board was turned. */
  onApply: (fen: string, orientation: Color) => void;
};

export function BoardEditor(props: BoardEditorProps) {
  const [pos, setPos] = createSignal<Position>(parseFen(START_FEN));
  const [orientation, setOrientation] = createSignal<Color>("w");
  const [tool, setTool] = createSignal<Tool>({ kind: "move" });
  const [drag, setDrag] = createSignal<Drag>();
  const [fenText, setFenText] = createSignal("");
  const [fenError, setFenError] = createSignal<string>();
  const [check, setCheck] = createSignal<Check>();

  /** Replaces the position, dropping castling and en passant rights the board no longer allows. */
  const load = (next: Position) => setPos(tidyPosition(next));

  // Start from the given position every time the dialog opens.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        batch(() => {
          load(parseFen(props.fen));
          setOrientation(props.orientation);
          setTool({ kind: "move" });
          setFenError(undefined);
          setDrag(undefined);
        });
      },
    ),
  );

  const fen = createMemo(() => toFen(pos()));
  createEffect(() => setFenText(fen()));

  // Ask Rust whether the position can be played, keeping only the latest answer.
  let request = 0;
  createEffect(() => {
    const current = fen();
    if (!props.open) return;
    const id = ++request;
    checkPosition(current).then(
      (normalized) => id === request && setCheck({ input: current, ok: true, fen: normalized }),
      (error) =>
        id === request && setCheck({ input: current, ok: false, message: errorMessage(error) }),
    );
  });

  const castling = createMemo(() => possibleCastling(pos()));
  const epSquares = createMemo(() => enPassantSquares(pos()));

  const update = (change: (pos: Position) => Partial<Position>) =>
    load({ ...pos(), ...change(pos()) });

  const setPiece = (square: Square, piece: Piece | undefined) =>
    update((current) => {
      const board = current.board.slice();
      board[squareIndex(square)] = piece;
      return { board };
    });

  /** Loads the FEN typed into the field, returning whether it could be read. */
  const commitFen = (): boolean => {
    const text = fenText().trim();
    if (text === fen()) return true;
    if (!looksLikeFen(text)) {
      setFenError("That doesn't look like a FEN.");
      return false;
    }
    setFenError(undefined);
    load(parseFen(text));
    return true;
  };

  // --- Pointer handling ---------------------------------------------------------------------

  let boardEl!: HTMLDivElement;
  /** While the pointer is held down with the piece or eraser tool, squares it crosses change too. */
  let painting: { piece?: Piece } | undefined;

  const squareAt = (x: number, y: number): Square | undefined => {
    const rect = boardEl.getBoundingClientRect();
    const col = Math.floor(((x - rect.left) / rect.width) * 8);
    const row = Math.floor(((y - rect.top) / rect.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return undefined;
    return cellToSquare(col, row, orientation());
  };

  const squareSize = () => boardEl.getBoundingClientRect().width / 8;

  const startDrag = (event: PointerEvent, piece: Piece, from?: Square) => {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({
      piece,
      from,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      size: squareSize(),
      moved: false,
    });
  };

  const onBoardPointerDown = (event: PointerEvent) => {
    const square = squareAt(event.clientX, event.clientY);
    if (!square || drag()) return;
    event.preventDefault();
    const occupant = pos().board[squareIndex(square)];
    const current = tool();
    if (event.button === 2 || (event.button === 0 && current.kind === "erase")) {
      painting = {};
    } else if (event.button === 0 && current.kind === "piece") {
      // Clicking a square that already holds the piece takes it away again.
      painting = samePiece(occupant, current.piece) ? {} : { piece: current.piece };
    } else if (event.button === 0 && occupant) {
      startDrag(event, occupant, square);
      return;
    } else {
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setPiece(square, painting.piece);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (painting) {
      const square = squareAt(event.clientX, event.clientY);
      if (square && !samePiece(pos().board[squareIndex(square)], painting.piece)) {
        setPiece(square, painting.piece);
      }
      return;
    }
    const current = drag();
    if (!current) return;
    const moved =
      current.moved ||
      Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > DRAG_THRESHOLD;
    setDrag({ ...current, x: event.clientX, y: event.clientY, moved });
  };

  const onPointerUp = (event: PointerEvent) => {
    painting = undefined;
    const current = drag();
    if (!current) return;
    setDrag(undefined);
    if (!current.moved) {
      // A click on a palette piece picks it as the tool.
      if (!current.from) setTool({ kind: "piece", piece: current.piece });
      return;
    }
    const target = squareAt(event.clientX, event.clientY);
    update(({ board }) => {
      const next = board.slice();
      if (current.from) next[squareIndex(current.from)] = undefined;
      // Dropped off the board: the piece is gone.
      if (target) next[squareIndex(target)] = current.piece;
      return { board: next };
    });
  };

  const onPointerCancel = () => {
    painting = undefined;
    setDrag(undefined);
  };

  // --- View ---------------------------------------------------------------------------------

  const paletteFor = (color: Color) => (
    <div class="flex justify-center gap-1 rounded-2xl bg-blush-100 p-1">
      <For each={PALETTE}>
        {(type) => {
          const piece = { color, type };
          const selected = () => {
            const current = tool();
            return current.kind === "piece" && samePiece(current.piece, piece);
          };
          return (
            <button
              type="button"
              title={`${pieceLabel(piece)}: click to place, or drag onto the board`}
              aria-label={`Place a ${color === "w" ? "white" : "black"} ${PIECE_NAMES[type]}`}
              aria-pressed={selected()}
              onPointerDown={(event) => event.button === 0 && startDrag(event, piece)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              class={`size-11 touch-none rounded-xl transition-colors ${
                selected() ? "bg-white ring-2 ring-rose" : "hover:bg-blush-200"
              }`}
            >
              <span
                class="board-piece-image block size-full"
                style={{ "background-image": `url("${pieceUrl(piece)}")` }}
              />
            </button>
          );
        }}
      </For>
    </div>
  );

  const toolButton = (kind: "move" | "erase", label: string, icon: () => JSX.Element) => (
    <button
      type="button"
      aria-pressed={tool().kind === kind}
      onClick={() => setTool({ kind })}
      class={`flex h-9 flex-1 items-center justify-center gap-2 rounded-xl text-[13px] font-bold transition-colors ${
        tool().kind === kind ? "bg-white ring-2 ring-rose" : "bg-blush-100 hover:bg-blush-200"
      }`}
    >
      {icon()}
      {label}
    </button>
  );

  const toggleCastling = (right: string) =>
    update((current) => ({
      castling: current.castling.includes(right)
        ? current.castling.replace(right, "")
        : "KQkq"
            .split("")
            .filter((r) => r === right || current.castling.includes(r))
            .join(""),
    }));

  /**
   * Whether the board is known to hold a position that can't be used. While a check is on its way
   * the button stays enabled, since applying checks again anyway.
   */
  const invalid = () => {
    const current = check();
    return current?.ok === false && current.input === fen();
  };

  const apply = async () => {
    // A FEN typed but not yet committed (the click is what blurred the field) counts.
    if (!commitFen()) return;
    const current = fen();
    try {
      const checked = await checkPosition(current);
      props.onApply(checked, orientation());
      props.onClose();
    } catch (error) {
      setCheck({ input: current, ok: false, message: errorMessage(error) });
    }
  };

  return (
    <Modal open={props.open} title="Set up a position" onClose={props.onClose} width={880}>
      <div class="grid min-h-0 grid-cols-[minmax(0,1fr)_280px] gap-5 overflow-y-auto">
        <div class="flex min-w-0 flex-col gap-2">
          {paletteFor(orientation() === "w" ? "b" : "w")}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-driven editor; the FEN field offers the same through the keyboard. */}
          <div
            ref={boardEl}
            class="relative mx-auto grid aspect-square w-full max-w-[440px] touch-none grid-cols-8 grid-rows-8 overflow-hidden rounded-[14px] ring-[6px] ring-(--board-frame)"
            onPointerDown={onBoardPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onContextMenu={(event) => event.preventDefault()}
          >
            <For each={displaySquares(orientation())}>
              {(square) => {
                const piece = () => pos().board[squareIndex(square)];
                const lifted = () => drag()?.moved && drag()?.from === square;
                return (
                  <div
                    class={`relative ${isLightSquare(square) ? "bg-(--board-light)" : "bg-(--board-dark)"}`}
                  >
                    <Show when={piece()}>
                      {(p) => (
                        <span
                          role="img"
                          aria-label={`${pieceLabel(p())} on ${square}`}
                          class={`board-piece-image absolute inset-0 ${lifted() ? "opacity-30" : ""}`}
                          style={{ "background-image": `url("${pieceUrl(p())}")` }}
                        />
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          {paletteFor(orientation())}
        </div>

        <div class="flex min-w-0 flex-col gap-3.5 text-[13px]">
          <div class="flex gap-1.5">
            {toolButton("move", "Move", () => (
              <HandIcon class="size-4" />
            ))}
            {toolButton("erase", "Erase", () => (
              <EraserIcon class="size-4" />
            ))}
          </div>
          <p class="-mt-1.5 text-[12px] text-muted">
            Drag pieces around, off the board to remove them, or pick one above and click squares.
            Right-click clears a square.
          </p>

          <fieldset class="flex flex-col gap-1.5">
            <legend class="mb-1.5 font-bold">Side to move</legend>
            <Segmented
              label="Side to move"
              size="sm"
              options={[
                { value: "w", label: "White" },
                { value: "b", label: "Black" },
              ]}
              value={pos().turn}
              onChange={(turn) => update(() => ({ turn }))}
            />
          </fieldset>

          <fieldset>
            <legend class="mb-1.5 font-bold">Castling</legend>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1">
              <For each={CASTLING_CHOICES}>
                {(choice) => (
                  <label
                    class={`flex items-center gap-2 ${castling().includes(choice.right) ? "" : "opacity-45"}`}
                    title={
                      castling().includes(choice.right)
                        ? undefined
                        : "The king and rook need to be on their starting squares"
                    }
                  >
                    <input
                      type="checkbox"
                      class="size-4 accent-rose"
                      checked={pos().castling.includes(choice.right)}
                      disabled={!castling().includes(choice.right)}
                      onChange={() => toggleCastling(choice.right)}
                    />
                    {choice.color === "w" ? "White" : "Black"} {choice.label}
                  </label>
                )}
              </For>
            </div>
          </fieldset>

          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1">
              <span class="font-bold">En passant</span>
              <select
                class={INPUT}
                disabled={epSquares().length === 0}
                value={pos().epSquare === undefined ? "" : squareName(pos().epSquare ?? 0)}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  update(() => ({ epSquare: value ? squareIndex(value) : undefined }));
                }}
              >
                <option value="">None</option>
                <For each={epSquares()}>{(square) => <option value={square}>{square}</option>}</For>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="font-bold">Move number</span>
              <input
                type="number"
                min="1"
                class={INPUT}
                value={pos().fullmove}
                onChange={(event) => {
                  const fullmove = Math.max(1, Math.floor(Number(event.currentTarget.value)) || 1);
                  event.currentTarget.value = String(fullmove);
                  update(() => ({ fullmove }));
                }}
              />
            </label>
          </div>

          <div class="flex flex-wrap gap-1.5">
            <button
              type="button"
              class={`${SECONDARY_BUTTON} h-8 px-3 text-[13px]`}
              onClick={() => load(parseFen(START_FEN))}
            >
              Starting position
            </button>
            <button
              type="button"
              class={`${SECONDARY_BUTTON} h-8 px-3 text-[13px]`}
              onClick={() => load(parseFen(EMPTY_FEN))}
            >
              Clear board
            </button>
            <button
              type="button"
              class={`${SECONDARY_BUTTON} h-8 px-3 text-[13px]`}
              onClick={() => setOrientation((side) => (side === "w" ? "b" : "w"))}
            >
              <FlipIcon class="size-4" />
              Flip
            </button>
          </div>

          <label class="flex flex-col gap-1">
            <span class="font-bold">FEN</span>
            <textarea
              rows={2}
              spellcheck={false}
              value={fenText()}
              onInput={(event) => setFenText(event.currentTarget.value)}
              onChange={commitFen}
              onPaste={() => setTimeout(commitFen)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitFen();
                }
              }}
              class="selectable resize-none rounded-xl border border-blush-200 bg-white px-3 py-2 font-mono text-[12px] leading-snug outline-none focus:border-rose"
            />
            <Show when={fenError()}>
              <span role="alert" class="font-semibold text-error">
                {fenError()}
              </span>
            </Show>
          </label>

          <div class="mt-auto flex flex-col gap-2.5">
            <p
              role="status"
              class={`flex min-h-5 items-start gap-1.5 font-semibold ${
                check()?.ok === false ? "text-error" : "text-nag-good"
              }`}
            >
              <Show when={check()}>
                {(current) => {
                  const result = current();
                  return result.ok ? (
                    <>
                      <CheckIcon class="size-4 shrink-0" />
                      Ready to analyse.
                    </>
                  ) : (
                    result.message
                  );
                }}
              </Show>
            </p>
            <button
              type="button"
              class={`${PRIMARY_BUTTON} justify-center`}
              disabled={invalid()}
              onClick={() => void apply()}
            >
              Analyse this position
            </button>
          </div>
        </div>
      </div>

      <Show when={drag()?.moved && drag()}>
        {(current) => (
          <span
            class="board-piece-image pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 scale-110"
            style={{
              left: `${current().x}px`,
              top: `${current().y}px`,
              width: `${current().size}px`,
              height: `${current().size}px`,
              "background-image": `url("${pieceUrl(current().piece)}")`,
            }}
          />
        )}
      </Show>
    </Modal>
  );
}
