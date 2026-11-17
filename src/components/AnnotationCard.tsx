// The Annotate panel's editor for the current move: its comment, move and position annotations,
// and the circles and arrows drawn on the board, which are saved in the PGN as `[%csl]`/`[%cal]`.

import { createEffect, createSignal, For, on, Show } from "solid-js";
import { parseComment } from "../chess/annotations";
import { moveNumberPrefix } from "../chess/board";
import {
  ALL_NAGS,
  hasNag,
  type NagChoice,
  OBSERVATION_NAGS,
  POSITION_NAGS,
  qualityNag,
} from "../chess/nag";
import type { GameSession } from "../game/session";
import { NAG_STYLES } from "./Notation";
import { Card, CardTitle } from "./ui";

const NAG_BUTTON =
  "h-7 min-w-8 rounded-lg px-1.5 text-[13px] font-bold transition-colors disabled:opacity-40";

export function AnnotationCard(props: { session: GameSession }) {
  const session = () => props.session;
  const node = () => session().node();
  const atRoot = () => node().parent === undefined;
  const [draft, setDraft] = createSignal("");

  // The comment box edits the current move's comment; it reloads when the move changes but not
  // while typing, so stored text never fights the cursor.
  createEffect(
    on(
      () => session().currentId(),
      () => setDraft(parseComment(node().comment).text),
    ),
  );

  const moveLabel = () => {
    const current = node();
    if (!current.move) return "Starting position";
    return `${moveNumberPrefix(current.ply - 1, true)} ${current.move.san}`;
  };

  const shapeSummary = () => {
    const shapes = session().shapes();
    const arrows = shapes.filter((s) => s.from !== s.to).length;
    const circles = shapes.length - arrows;
    const parts = [
      arrows > 0 ? `${arrows} ${arrows === 1 ? "arrow" : "arrows"}` : "",
      circles > 0 ? `${circles} ${circles === 1 ? "circle" : "circles"}` : "",
    ].filter(Boolean);
    return parts.join(", ");
  };

  const choiceRow = (label: string, choices: readonly NagChoice[]) => (
    <fieldset class="flex flex-wrap items-center gap-1.5">
      <legend class="sr-only">{label}</legend>
      <span aria-hidden="true" class="w-[70px] text-[12px] font-bold text-muted">
        {label}
      </span>
      <For each={choices}>
        {(choice) => {
          const active = () => hasNag(node().nags, choice);
          return (
            <button
              type="button"
              title={choice.label}
              aria-label={choice.label}
              aria-pressed={active()}
              disabled={atRoot()}
              onClick={() => session().toggleNagFor(choice)}
              class={`${NAG_BUTTON} ${
                active()
                  ? "bg-white text-rose-strong ring-2 ring-rose"
                  : "bg-blush-100 hover:bg-blush-200"
              }`}
            >
              {choice.symbol}
            </button>
          );
        }}
      </For>
    </fieldset>
  );

  return (
    <Card class="flex shrink-0 flex-col gap-2.5 px-[18px] pt-3 pb-4">
      <div class="flex items-baseline gap-3">
        <CardTitle>Annotate</CardTitle>
        <span class="truncate font-mono text-[13px] font-bold text-ink/80">{moveLabel()}</span>
      </div>

      <label class="flex flex-col gap-1">
        <span class="sr-only">Comment on {moveLabel()}</span>
        <textarea
          rows={3}
          value={draft()}
          placeholder={
            atRoot() ? "A note about the starting position…" : "What's the idea behind this move?"
          }
          onInput={(event) => {
            setDraft(event.currentTarget.value);
            session().setComment(event.currentTarget.value);
          }}
          class="selectable resize-none rounded-xl border border-blush-200 bg-white px-3 py-2 text-[14px] leading-snug outline-none placeholder:text-ink/45 focus:border-rose"
        />
      </label>

      <fieldset class="flex flex-wrap items-center gap-1.5">
        <legend class="sr-only">Move</legend>
        <span aria-hidden="true" class="w-[70px] text-[12px] font-bold text-muted">
          Move
        </span>
        <For each={ALL_NAGS}>
          {(nag) => {
            const active = () => qualityNag(node().nags) === nag;
            return (
              <button
                type="button"
                title={NAG_STYLES[nag].label}
                aria-label={NAG_STYLES[nag].label}
                aria-pressed={active()}
                disabled={atRoot()}
                onClick={() => session().toggleNag(nag)}
                class={`${NAG_BUTTON} ${NAG_STYLES[nag].text} ${
                  active() ? "bg-white ring-2 ring-current" : "bg-blush-100 hover:bg-blush-200"
                }`}
              >
                {nag}
              </button>
            );
          }}
        </For>
      </fieldset>
      {choiceRow("Position", POSITION_NAGS)}
      {choiceRow("Ideas", OBSERVATION_NAGS)}

      <div class="flex items-center gap-2 rounded-xl bg-blush-100/70 px-3 py-1.5 text-[12px]">
        <span class="min-w-0 flex-1 text-ink/80">
          <Show
            when={shapeSummary()}
            fallback="Right-drag on the board to draw arrows, right-click for circles. Shift, Alt or both change the colour."
          >
            <span class="font-bold">Drawn here:</span> {shapeSummary()}, saved with the game.
          </Show>
        </span>
        <Show when={shapeSummary()}>
          <button
            type="button"
            onClick={() => session().setShapes([])}
            class="shrink-0 rounded-lg px-2 py-0.5 font-bold text-rose-strong hover:bg-blush-200"
          >
            Clear
          </button>
        </Show>
      </div>
    </Card>
  );
}
