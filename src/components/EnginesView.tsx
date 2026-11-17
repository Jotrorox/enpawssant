// The Engines section: the bundled Stockfish and any UCI engine the user adds, which engine
// analyses the board, an optional second engine that runs alongside it, and each engine's options.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  addEngine,
  BUNDLED_ENGINE,
  type EngineEntry,
  enginesConfig,
  enginesLoaded,
  loadEngines,
  MANAGED_OPTIONS,
  optionValue,
  probeEngine,
  removeEngine,
  renameEngine,
  setEngineOption,
  setEngineRoles,
  type UciOption,
} from "../chess/engines";
import { EngineIcon, PlusIcon, TrashIcon } from "./Icons";
import {
  Card,
  CardTitle,
  EmptyState,
  INPUT,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  ViewHeader,
} from "./ui";

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

/** Options whose default EnPawssant picks itself (see `startup_values` in `engine.rs`). */
const AUTO_DEFAULTS: Record<string, string> = {
  Threads: "all cores but one",
  Hash: "256 MB",
};

export function EnginesView() {
  const [selectedId, setSelectedId] = createSignal<string>(BUNDLED_ENGINE);
  const [error, setError] = createSignal<string>();
  const [adding, setAdding] = createSignal(false);
  onMount(() => void loadEngines());

  const selected = createMemo(
    () =>
      enginesConfig.engines.find((engine) => engine.id === selectedId()) ??
      enginesConfig.engines[0],
  );

  const attempt = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const add = () =>
    attempt(async () => {
      setAdding(true);
      try {
        const before = new Set(enginesConfig.engines.map((engine) => engine.id));
        if (await addEngine()) {
          const added = enginesConfig.engines.find((engine) => !before.has(engine.id));
          if (added) setSelectedId(added.id);
        }
      } finally {
        setAdding(false);
      }
    });

  return (
    <div class="flex h-full min-h-0 flex-col gap-3.5 p-3.5 pl-[18px]">
      <ViewHeader
        title="Engines"
        subtitle="Any UCI engine works. One analyses the board; a second can think alongside it."
      >
        <button type="button" class={PRIMARY_BUTTON} disabled={adding()} onClick={() => void add()}>
          <PlusIcon class="size-[18px]" />
          {adding() ? "Checking the engine…" : "Add engine…"}
        </button>
      </ViewHeader>

      <Show when={error()}>
        {(message) => (
          <p role="alert" class="shrink-0 text-[13px] font-semibold text-error">
            Mochi got tangled in the cables: {message()}
          </p>
        )}
      </Show>

      <div class="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-3.5">
        <Card class="flex min-h-0 flex-col px-3 pt-3 pb-2">
          <div class="mb-1.5 px-1.5">
            <CardTitle>Your engines</CardTitle>
          </div>
          <Show
            when={enginesLoaded()}
            fallback={<p class="px-1.5 text-[13px] text-muted">Loading…</p>}
          >
            <ul class="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
              <For each={enginesConfig.engines}>
                {(engine) => (
                  <li>
                    <button
                      type="button"
                      onClick={() => setSelectedId(engine.id)}
                      aria-current={selected()?.id === engine.id ? "true" : undefined}
                      class={`flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                        selected()?.id === engine.id ? "bg-blush-100" : "hover:bg-blush-100/60"
                      }`}
                    >
                      <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-white text-rose ring-1 ring-blush-200">
                        <EngineIcon class="size-5" />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[14px] font-bold">{engine.name}</span>
                        <span class="block truncate text-[12px] text-muted">
                          {engine.path === null ? "Bundled" : fileName(engine.path)}
                        </span>
                      </span>
                      <RoleBadge id={engine.id} />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Card>

        <Show when={selected()} fallback={<Card class="p-5" />}>
          {(engine) => <EngineDetails engine={engine()} onAction={attempt} />}
        </Show>
      </div>
    </div>
  );
}

function RoleBadge(props: { id: string }) {
  return (
    <Switch>
      <Match when={enginesConfig.primary === props.id}>
        <span class="shrink-0 rounded-full bg-rose px-2 py-0.5 text-[11px] font-bold text-white">
          Analysis
        </span>
      </Match>
      <Match when={enginesConfig.secondary === props.id}>
        <span class="shrink-0 rounded-full bg-lavender px-2 py-0.5 text-[11px] font-bold text-ink ring-1 ring-blush-200">
          Alongside
        </span>
      </Match>
    </Switch>
  );
}

function EngineDetails(props: {
  engine: EngineEntry;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [probing, setProbing] = createSignal(false);
  const [name, setName] = createSignal(props.engine.name);
  createEffect(on(() => props.engine.name, setName));

  // An engine that has never run doesn't know its options yet: start it once to find out.
  createEffect(
    on(
      () => props.engine.id,
      (id) => {
        if (props.engine.options.length > 0) return;
        setProbing(true);
        void props.onAction(() => probeEngine(id)).finally(() => setProbing(false));
      },
    ),
  );

  const isPrimary = () => enginesConfig.primary === props.engine.id;
  const isSecondary = () => enginesConfig.secondary === props.engine.id;
  const options = () =>
    props.engine.options.filter(
      (option) => option.type !== "button" && !MANAGED_OPTIONS.has(option.name),
    );

  const makePrimary = () =>
    props.onAction(() =>
      setEngineRoles(
        props.engine.id,
        // An engine can't run alongside itself, so promoting the second engine leaves none.
        enginesConfig.secondary === props.engine.id ? null : enginesConfig.secondary,
      ),
    );
  const toggleSecondary = () =>
    props.onAction(() =>
      setEngineRoles(enginesConfig.primary, isSecondary() ? null : props.engine.id),
    );
  const remove = () => {
    if (!window.confirm(`Remove ${props.engine.name}? The engine file itself stays where it is.`)) {
      return;
    }
    void props.onAction(() => removeEngine(props.engine.id));
  };
  const commitName = () => {
    const next = name().trim();
    if (next && next !== props.engine.name) {
      void props.onAction(() => renameEngine(props.engine.id, next));
    } else {
      setName(props.engine.name);
    }
  };

  return (
    <Card class="flex min-h-0 flex-col gap-4 px-5 pt-4 pb-4">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <input
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setName(props.engine.name);
                event.currentTarget.blur();
              }
            }}
            aria-label="Engine name"
            title="Rename"
            class="-ml-1.5 w-full rounded-lg bg-transparent px-1.5 font-display text-[18px] font-semibold outline-none hover:bg-blush-100/60 focus:bg-white focus:ring-1 focus:ring-rose"
          />
          <p class="truncate text-[12px] text-muted" title={props.engine.path ?? undefined}>
            {props.engine.author ? `by ${props.engine.author} · ` : ""}
            {props.engine.path ?? "Bundled with EnPawssant"}
          </p>
        </div>
        <Show when={props.engine.id !== BUNDLED_ENGINE}>
          <button type="button" class={SECONDARY_BUTTON} onClick={remove}>
            <TrashIcon class="size-[18px]" />
            Remove
          </button>
        </Show>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <RoleCard
          title="Analyses the board"
          description="Drives the engine lines, eval bar, arrows and full-game analysis."
          active={isPrimary()}
          action={isPrimary() ? undefined : "Use for analysis"}
          onAction={() => void makePrimary()}
        />
        <RoleCard
          title="Thinks alongside"
          description="Analyses the same positions next to the main engine, to compare their lines."
          active={isSecondary()}
          disabled={isPrimary()}
          action={isPrimary() ? undefined : isSecondary() ? "Stop" : "Run alongside"}
          onAction={() => void toggleSecondary()}
        />
      </div>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="mb-2 flex items-baseline gap-2">
          <CardTitle>Options</CardTitle>
          <span class="text-[12px] text-muted">The engine restarts when an option changes.</span>
        </div>
        <Switch>
          <Match when={probing()}>
            <EmptyState>Waking the engine up to ask about its options…</EmptyState>
          </Match>
          <Match when={options().length === 0}>
            <EmptyState>This engine has no options to change.</EmptyState>
          </Match>
          <Match when={true}>
            <div class="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              <ul class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-5 gap-y-1">
                <For each={options()}>
                  {(option) => (
                    <OptionRow
                      engine={props.engine}
                      option={option}
                      onChange={(value) =>
                        props.onAction(() => setEngineOption(props.engine.id, option.name, value))
                      }
                    />
                  )}
                </For>
              </ul>
            </div>
          </Match>
        </Switch>
      </div>
    </Card>
  );
}

function RoleCard(props: {
  title: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  action?: string;
  onAction: () => void;
}) {
  return (
    <div
      class={`flex flex-col gap-2 rounded-2xl border px-4 py-3 ${
        props.active ? "border-rose bg-blush-100/70" : "border-blush-200 bg-white"
      } ${props.disabled ? "opacity-60" : ""}`}
    >
      <div class="flex items-center gap-2">
        <span
          class={`size-2.5 rounded-full ${props.active ? "bg-rose" : "bg-plum-soft"}`}
          aria-hidden="true"
        />
        <span class="text-[14px] font-bold">{props.title}</span>
        <Show when={props.action}>
          {(label) => (
            <button
              type="button"
              class={`${SECONDARY_BUTTON} ml-auto h-7 rounded-lg px-2.5 text-[12px]`}
              onClick={() => props.onAction()}
            >
              {label()}
            </button>
          )}
        </Show>
      </div>
      <p class="text-[12px] leading-snug text-muted">{props.description}</p>
    </div>
  );
}

function OptionRow(props: {
  engine: EngineEntry;
  option: UciOption;
  onChange: (value: string | null) => Promise<void>;
}) {
  const changed = () => props.engine.values[props.option.name] !== undefined;
  const auto = () => (changed() ? undefined : AUTO_DEFAULTS[props.option.name]);
  const value = () => optionValue(props.engine, props.option);
  const id = () => `option-${props.engine.id}-${props.option.name.replace(/\W+/g, "-")}`;

  const control = () => {
    const option = props.option;
    switch (option.type) {
      case "check":
        return (
          <button
            id={id()}
            type="button"
            role="switch"
            aria-checked={value() === "true"}
            onClick={() => void props.onChange(value() === "true" ? "false" : "true")}
            class={`relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors ${
              value() === "true" ? "bg-rose" : "bg-plum-soft"
            }`}
          >
            <span
              class={`absolute top-[3px] left-[3px] size-[14px] rounded-full bg-white shadow transition-transform ${
                value() === "true" ? "translate-x-[14px]" : ""
              }`}
            />
          </button>
        );
      case "spin":
        return (
          <input
            id={id()}
            type="number"
            min={option.min}
            max={option.max}
            value={auto() ? "" : value()}
            placeholder={auto() ? "Auto" : undefined}
            onChange={(event) => {
              const text = event.currentTarget.value.trim();
              void props.onChange(text === "" ? null : text);
            }}
            class={`${INPUT} h-8 w-28 text-right font-mono text-[13px]`}
          />
        );
      case "combo":
        return (
          <select
            id={id()}
            value={value()}
            onChange={(event) => void props.onChange(event.currentTarget.value)}
            class={`${INPUT} h-8 w-40 text-[13px]`}
          >
            <For each={option.choices}>{(choice) => <option value={choice}>{choice}</option>}</For>
          </select>
        );
      case "string":
        return (
          <input
            id={id()}
            value={value()}
            spellcheck={false}
            onChange={(event) => void props.onChange(event.currentTarget.value)}
            class={`${INPUT} h-8 w-40 font-mono text-[12px]`}
          />
        );
      default:
        return null;
    }
  };

  const hint = () => {
    const option = props.option;
    if (auto()) return `Auto: ${auto()}`;
    if (option.type === "spin") return `${option.min}–${option.max}`;
    return undefined;
  };

  return (
    <li class="flex min-h-11 items-center gap-3 border-b border-blush-100 py-1.5">
      <label for={id()} class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-bold" title={props.option.name}>
          {props.option.name}
        </span>
        <Show when={hint()}>
          <span class="block truncate text-[11px] text-muted">{hint()}</span>
        </Show>
      </label>
      <Show when={changed()}>
        <button
          type="button"
          class="shrink-0 text-[11px] font-semibold text-muted underline-offset-2 hover:text-ink hover:underline"
          title="Back to the default"
          onClick={() => void props.onChange(null)}
        >
          Reset
        </button>
      </Show>
      {control()}
    </li>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
