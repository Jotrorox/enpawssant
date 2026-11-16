import { createEffect, createResource, createSignal, type JSX, Show } from "solid-js";
import { type Color, START_FEN } from "../chess/board";
import { type EngineInfo, fetchOpponentInfo, type StrengthRange } from "../chess/engine";
import { rulesOutcome } from "../chess/outcome";
import type { TimeControl } from "../game/clock";
import type { PlaySettings } from "../game/play";
import { ChessClockIcon } from "./Icons";
import { EmptyState, Modal, PRIMARY_BUTTON, SECONDARY_BUTTON, Segmented } from "./ui";

/** A new game, as the dialog hands it over. */
export type NewGame = { settings: PlaySettings; startFen: string; engineName: string };

type ColorChoice = "w" | "random" | "b";
type StrengthMode = "elo" | "skill";
type Start = "start" | "current";

const COLORS = [
  { value: "w", label: "White" },
  { value: "random", label: "Random" },
  { value: "b", label: "Black" },
] as const;

const STRENGTH_MODES = [
  { value: "elo", label: "Elo" },
  { value: "skill", label: "Skill level" },
] as const;

const TIME_PRESETS = [
  { value: "untimed", label: "Untimed" },
  { value: "3+2", label: "3+2" },
  { value: "5+3", label: "5+3" },
  { value: "10+5", label: "10+5" },
  { value: "15+10", label: "15+10" },
  { value: "custom", label: "Custom" },
] as const;

type TimePreset = (typeof TIME_PRESETS)[number]["value"];

const STARTS = [
  { value: "start", label: "Starting position" },
  { value: "current", label: "Current position" },
] as const;

/** Stockfish's ranges, for before the engine has described itself. */
const FALLBACK_ELO: StrengthRange = { min: 1320, max: 3190, default: 1320 };
const FALLBACK_SKILL: StrengthRange = { min: 0, max: 20, default: 20 };
const ELO_STEP = 10;

type Choices = {
  color: ColorChoice;
  mode: StrengthMode;
  elo: number;
  skill: number;
  time: TimePreset;
  /** Custom time control. */
  minutes: number;
  increment: number;
};

const DEFAULTS: Choices = {
  color: "w",
  mode: "elo",
  elo: 1500,
  skill: 5,
  time: "5+3",
  minutes: 10,
  increment: 0,
};

/** The dialog remembers the last game's choices; losing them only costs a few clicks. */
const STORAGE_KEY = "enpawssant.play";

function loadChoices(): Choices {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const choices = { ...DEFAULTS, ...saved };
    const valid =
      COLORS.some((c) => c.value === choices.color) &&
      STRENGTH_MODES.some((m) => m.value === choices.mode) &&
      TIME_PRESETS.some((t) => t.value === choices.time) &&
      [choices.elo, choices.skill, choices.minutes, choices.increment].every(Number.isFinite);
    return valid ? choices : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function saveChoices(choices: Choices) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage may be unavailable; the dialog then starts from the defaults next time.
  }
}

function timeControl(choices: Choices): TimeControl | undefined {
  if (choices.time === "untimed") return undefined;
  const [minutes, increment] =
    choices.time === "custom"
      ? [choices.minutes, choices.increment]
      : choices.time.split("+").map(Number);
  return { initialMs: minutes * 60_000, incrementMs: increment * 1000 };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type PlayDialogProps = {
  open: boolean;
  /** The position on the board, which the game can start from. */
  currentFen?: string;
  onClose: () => void;
  onStart: (game: NewGame) => void;
};

export function PlayDialog(props: PlayDialogProps) {
  const [choices, setChoices] = createSignal<Choices>(loadChoices());
  const [start, setStart] = createSignal<Start>("start");
  // Asking for the engine's ranges also wakes it up before the first move.
  const [engine] = createResource(() => props.open || undefined, fetchOpponentInfo);
  const info = (): EngineInfo | undefined => (engine.error ? undefined : engine());

  const eloRange = () => info()?.elo ?? FALLBACK_ELO;
  const skillRange = () => info()?.skill ?? FALLBACK_SKILL;
  const update = (change: Partial<Choices>) => setChoices({ ...choices(), ...change });

  /** Whether the game can start from the board's position: a different, unfinished one. */
  const currentPlayable = () =>
    !!props.currentFen && props.currentFen !== START_FEN && !rulesOutcome([props.currentFen]);

  createEffect(() => {
    if (props.open) setStart("start");
  });

  const startGame = () => {
    const engineInfo = info();
    if (!engineInfo) return;
    const picked = choices();
    saveChoices(picked);
    const color: Color =
      picked.color === "random" ? (Math.random() < 0.5 ? "w" : "b") : picked.color;
    const elo = clamp(picked.elo, eloRange().min, eloRange().max);
    const skill = clamp(picked.skill, skillRange().min, skillRange().max);
    props.onStart({
      settings: {
        color,
        strength: picked.mode === "elo" && engineInfo.elo ? { elo } : { skill },
        timeControl: timeControl(picked),
      },
      startFen:
        start() === "current" && currentPlayable() ? (props.currentFen ?? START_FEN) : START_FEN,
      engineName: engineInfo.name,
    });
    props.onClose();
  };

  return (
    <Modal open={props.open} title="Play vs Stockfish" onClose={props.onClose}>
      <Show
        when={!engine.error}
        fallback={
          <EmptyState class="text-error">
            Stockfish couldn't wake up: {String(engine.error)}
          </EmptyState>
        }
      >
        <div class="flex flex-col gap-4">
          <Field label="You play">
            <Segmented
              label="Your colour"
              options={COLORS}
              value={choices().color}
              onChange={(color) => update({ color })}
            />
          </Field>

          <Field label="Strength">
            <Segmented
              label="Strength setting"
              options={STRENGTH_MODES.filter((mode) =>
                mode.value === "elo" ? !info() || info()?.elo : !info() || info()?.skill,
              )}
              value={choices().mode}
              onChange={(mode) => update({ mode })}
            />
            <Show
              when={choices().mode === "elo"}
              fallback={
                <Slider
                  label="Skill level"
                  range={skillRange()}
                  step={1}
                  value={clamp(choices().skill, skillRange().min, skillRange().max)}
                  onChange={(skill) => update({ skill })}
                  hint="Level 20 is full strength. Lower levels play weaker moves on purpose."
                />
              }
            >
              <Slider
                label="Elo"
                range={eloRange()}
                step={ELO_STEP}
                value={clamp(choices().elo, eloRange().min, eloRange().max)}
                onChange={(elo) => update({ elo })}
                hint={`Stockfish can limit itself to ${eloRange().min}–${eloRange().max}. Its ratings come from games against other engines, so it may feel stronger than a person rated the same.`}
              />
            </Show>
          </Field>

          <Field label="Time control">
            <Segmented
              label="Time control"
              options={TIME_PRESETS}
              value={choices().time}
              onChange={(time) => update({ time })}
            />
            <Show when={choices().time === "custom"}>
              <div class="flex items-center gap-4 text-[13px] font-semibold">
                <NumberInput
                  label="Minutes"
                  min={1}
                  max={180}
                  value={choices().minutes}
                  onChange={(minutes) => update({ minutes })}
                />
                <NumberInput
                  label="Increment (s)"
                  min={0}
                  max={60}
                  value={choices().increment}
                  onChange={(increment) => update({ increment })}
                />
              </div>
            </Show>
          </Field>

          <Field label="Start from">
            <Segmented
              label="Start from"
              options={STARTS.filter((s) => s.value === "start" || currentPlayable())}
              value={start()}
              onChange={setStart}
            />
          </Field>

          <p class="text-[12px] text-muted">
            Live analysis, the eval bar and the opening explorer take a nap until the game is over.
          </p>

          <div class="flex items-center justify-end gap-2">
            <button type="button" class={SECONDARY_BUTTON} onClick={() => props.onClose()}>
              Cancel
            </button>
            <button type="button" class={PRIMARY_BUTTON} disabled={!info()} onClick={startGame}>
              <ChessClockIcon class="size-[18px]" />
              {engine.loading ? "Waking up Stockfish…" : "Start game"}
            </button>
          </div>
        </div>
      </Show>
    </Modal>
  );
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <fieldset class="flex flex-col gap-2">
      <legend class="mb-2 text-[11px] font-bold tracking-[0.08em] text-ink/70 uppercase">
        {props.label}
      </legend>
      {props.children}
    </fieldset>
  );
}

function Slider(props: {
  label: string;
  range: StrengthRange;
  step: number;
  value: number;
  onChange: (value: number) => void;
  hint: string;
}) {
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-3">
        <input
          type="range"
          aria-label={props.label}
          min={props.range.min}
          max={props.range.max}
          step={props.step}
          value={props.value}
          onInput={(event) => props.onChange(Number(event.currentTarget.value))}
          class="flex-1 accent-rose"
        />
        <span class="w-[86px] shrink-0 rounded-lg bg-white px-2 py-0.5 text-right font-mono text-[13px] ring-1 ring-blush-200">
          {props.label === "Elo" ? props.value : `level ${props.value}`}
        </span>
      </div>
      <p class="text-[12px] text-muted">{props.hint}</p>
    </div>
  );
}

function NumberInput(props: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label class="flex items-center gap-2">
      {props.label}
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(event) => {
          const value = Math.round(Number(event.currentTarget.value));
          const valid = Number.isFinite(value) ? clamp(value, props.min, props.max) : props.min;
          event.currentTarget.value = String(valid);
          props.onChange(valid);
        }}
        class="w-[72px] rounded-lg border border-blush-200 bg-white px-2 py-1 font-mono outline-none focus:border-rose"
      />
    </label>
  );
}
