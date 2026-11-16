import { createEffect, createMemo, For, Show } from "solid-js";
import { formatEval, moveNumberPrefix } from "../chess/board";
import { type GameMove, NAGS, type Nag, type Variation } from "../data/mockGame";
import { Card, CardTitle } from "./ui";

const NAG_STYLES: Record<Nag, { text: string; label: string }> = {
  "!!": { text: "text-nag-brilliant", label: "Brilliant move" },
  "!": { text: "text-nag-good", label: "Good move" },
  "!?": { text: "text-nag-interesting", label: "Interesting move" },
  "?!": { text: "text-nag-dubious", label: "Dubious move" },
  "?": { text: "text-nag-mistake", label: "Mistake" },
};

type Segment = { kind: "moves"; plies: number[] } | { kind: "variation"; variation: Variation };

/** Splits the mainline into runs of moves separated by variation blocks. */
function segmentMainline(moves: GameMove[], variations: Variation[]): Segment[] {
  const segments: Segment[] = [];
  let run: number[] = [];
  moves.forEach((_, index) => {
    const ply = index + 1;
    run.push(ply);
    const branches = variations.filter((v) => v.ply === ply);
    if (branches.length > 0) {
      segments.push({ kind: "moves", plies: run });
      for (const variation of branches) segments.push({ kind: "variation", variation });
      run = [];
    }
  });
  if (run.length > 0) segments.push({ kind: "moves", plies: run });
  return segments;
}

type NotationProps = {
  moves: GameMove[];
  variations: Variation[];
  ply: number;
  fen: string;
  onPly: (ply: number) => void;
  onToggleNag: (nag: Nag) => void;
};

export function Notation(props: NotationProps) {
  const segments = createMemo(() => segmentMainline(props.moves, props.variations));
  const currentNag = () => (props.ply > 0 ? props.moves[props.ply - 1].nag : undefined);
  let scroller: HTMLDivElement | undefined;

  // Keep the current move in view while stepping through the game.
  createEffect(() => {
    const ply = props.ply;
    scroller?.querySelector(`[data-ply="${ply}"]`)?.scrollIntoView({ block: "nearest" });
  });

  return (
    <Card class="flex min-h-[180px] flex-1 flex-col px-[18px] pt-3 pb-3.5">
      <div class="mb-2 flex items-center gap-3">
        <CardTitle>Paw prints</CardTitle>
        <span class="text-[12px] text-muted">
          Notation · {props.variations.length}{" "}
          {props.variations.length === 1 ? "variation" : "variations"}
        </span>
        <fieldset class="ml-auto flex gap-1.5">
          <legend class="sr-only">Annotate current move</legend>
          <For each={NAGS}>
            {(nag) => (
              <button
                type="button"
                title={NAG_STYLES[nag].label}
                aria-label={NAG_STYLES[nag].label}
                aria-pressed={currentNag() === nag}
                disabled={props.ply === 0}
                onClick={() => props.onToggleNag(nag)}
                class={`h-7 min-w-8 rounded-lg px-1.5 text-[13px] font-bold transition-colors disabled:opacity-40 ${
                  NAG_STYLES[nag].text
                } ${
                  currentNag() === nag
                    ? "bg-white ring-2 ring-current"
                    : "bg-blush-100 hover:bg-blush-200"
                }`}
              >
                {nag}
              </button>
            )}
          </For>
        </fieldset>
      </div>

      <div ref={scroller} class="min-h-0 flex-1 overflow-y-auto pr-1 text-[15px] leading-[2]">
        <For each={segments()}>
          {(segment, index) =>
            segment.kind === "moves" ? (
              <p>
                <For each={segment.plies}>
                  {(ply, i) => (
                    <MainlineMove
                      move={props.moves[ply - 1]}
                      ply={ply}
                      showBlackNumber={i() === 0 && index() > 0}
                      current={ply === props.ply}
                      onSelect={() => props.onPly(ply)}
                    />
                  )}
                </For>
              </p>
            ) : (
              <VariationLine variation={segment.variation} />
            )
          }
        </For>
      </div>

      <div class="mt-2 flex items-center gap-3 rounded-xl bg-blush-100/70 px-3.5 py-2 text-[12px]">
        <span class="font-bold text-ink/70">FEN</span>
        <span class="selectable truncate font-mono text-ink">{props.fen}</span>
      </div>
    </Card>
  );
}

function MainlineMove(props: {
  move: GameMove;
  ply: number;
  showBlackNumber: boolean;
  current: boolean;
  onSelect: () => void;
}) {
  const prefix = () => moveNumberPrefix(props.ply - 1, props.showBlackNumber);
  const nagClass = () => (props.move.nag ? `${NAG_STYLES[props.move.nag].text} font-bold` : "");

  return (
    <>
      <Show when={prefix()}>
        <span class="ml-1 text-ink/75 first:ml-0">{prefix()} </span>
      </Show>
      <button
        type="button"
        data-ply={props.ply}
        aria-current={props.current ? "step" : undefined}
        onClick={() => props.onSelect()}
        class={`rounded-lg px-[3px] transition-colors ${
          props.current ? "bg-blush-300 font-bold" : "hover:bg-blush-100"
        } ${nagClass()}`}
      >
        {props.move.san}
        {props.move.nag}
      </button>
      <Show when={props.current}>
        <span class="ml-1.5 font-mono text-[12px] text-ink/75">{formatEval(props.move.eval)}</span>
      </Show>{" "}
    </>
  );
}

function VariationLine(props: { variation: Variation }) {
  return (
    <p class="my-1 ml-1 border-l-2 border-rose/60 pl-4 text-[14px] leading-relaxed text-ink/85">
      (
      <For each={props.variation.moves}>
        {(move, i) => {
          const prefix = moveNumberPrefix(props.variation.ply - 1 + i(), i() === 0);
          return (
            <>
              {i() > 0 ? " " : ""}
              {prefix ? `${prefix} ` : ""}
              <span class={move.nag ? `${NAG_STYLES[move.nag].text} font-bold` : ""}>
                {move.san}
                {move.nag}
              </span>
            </>
          );
        }}
      </For>
      )
      <Show when={props.variation.comment}>
        {" "}
        <em class="text-ink/90">{props.variation.comment}</em>
      </Show>
    </p>
  );
}
