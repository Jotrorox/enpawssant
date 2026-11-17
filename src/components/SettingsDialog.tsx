// The settings dialog behind the ⚙ button: appearance, sound, the analysis engine and updates.

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
} from "solid-js";
import { fetchEngineInfo } from "../chess/engine";
import {
  engineRevision,
  enginesConfig,
  loadEngines,
  probeEngine,
  setEngineOption,
  type UciOption,
} from "../chess/engines";
import { pieceUrl } from "../chess/pieces";
import { playSound, setSoundEnabled, soundEnabled } from "../chess/sound";
import {
  BOARD_THEMES,
  MAX_MULTIPV,
  PIECE_SETS,
  settings,
  THEME_MODES,
  updateSettings,
} from "../settings";
import {
  appVersion,
  checkForUpdates,
  type DownloadProgress,
  installUpdate,
  restartApp,
  type UpdateState,
  updateState,
} from "../updates";
import { SoundOffIcon, SoundOnIcon } from "./Icons";
import { INPUT, Modal, PRIMARY_BUTTON, ProgressBar, SECONDARY_BUTTON, Segmented } from "./ui";

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

export function SettingsDialog(props: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={props.open} title="Settings" onClose={props.onClose} width={600}>
      <div class="-mx-1 flex min-h-0 flex-col gap-5 overflow-y-auto px-1 pb-1">
        <Section title="Appearance">
          <Row label="Theme">
            <Segmented
              label="Theme"
              size="sm"
              options={THEME_MODES}
              value={settings.theme}
              onChange={(theme) => updateSettings({ theme })}
            />
          </Row>
          <Row label="Board" align="start">
            <div class="grid grid-cols-3 gap-2">
              <For each={BOARD_THEMES}>
                {(theme) => (
                  <Choice
                    selected={settings.boardTheme === theme.value}
                    onSelect={() => updateSettings({ boardTheme: theme.value })}
                    label={theme.label}
                  >
                    <span class="grid size-9 shrink-0 grid-cols-2 overflow-hidden rounded-lg">
                      <span style={{ background: theme.light }} />
                      <span style={{ background: theme.dark }} />
                      <span style={{ background: theme.dark }} />
                      <span style={{ background: theme.light }} />
                    </span>
                  </Choice>
                )}
              </For>
            </div>
          </Row>
          <Row label="Pieces" align="start">
            <div class="grid grid-cols-2 gap-2">
              <For each={PIECE_SETS}>
                {(set) => (
                  <Choice
                    selected={settings.pieceSet === set.value}
                    onSelect={() => updateSettings({ pieceSet: set.value })}
                    label={set.label}
                  >
                    <span class="flex shrink-0 rounded-lg bg-(--board-light) p-0.5">
                      <For
                        each={
                          [
                            { color: "w", type: "n" },
                            { color: "b", type: "q" },
                          ] as const
                        }
                      >
                        {(piece) => (
                          <span
                            class="board-piece-image size-8"
                            style={{ "background-image": `url("${pieceUrl(piece, set.value)}")` }}
                          />
                        )}
                      </For>
                    </span>
                  </Choice>
                )}
              </For>
            </div>
          </Row>
        </Section>

        <Section title="Sound">
          <Row label="Volume">
            <div class="flex items-center gap-3">
              <button
                type="button"
                aria-label={soundEnabled() ? "Mute move sounds" : "Unmute move sounds"}
                title={soundEnabled() ? "Mute move sounds" : "Unmute move sounds"}
                onClick={() => setSoundEnabled(!soundEnabled())}
                class="grid size-8 shrink-0 place-items-center rounded-lg hover:bg-blush-100"
              >
                <Show when={soundEnabled()} fallback={<SoundOffIcon class="size-5" />}>
                  <SoundOnIcon class="size-5" />
                </Show>
              </button>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                aria-label="Volume"
                value={settings.volume}
                disabled={!soundEnabled()}
                onInput={(event) => updateSettings({ volume: Number(event.currentTarget.value) })}
                // A knock at the new volume once the slider is let go.
                onChange={() => playSound("move")}
                class="min-w-0 flex-1 accent-rose disabled:opacity-40"
              />
              <span class="w-9 text-right font-mono text-[12px] text-ink/75">
                {soundEnabled() ? `${settings.volume}%` : "Off"}
              </span>
            </div>
          </Row>
        </Section>

        <EngineSettings open={props.open} />

        <UpdateSettings />
      </div>
    </Modal>
  );
}

function EngineSettings(props: { open: boolean }) {
  const engine = createMemo(() =>
    enginesConfig.engines.find((entry) => entry.id === enginesConfig.primary),
  );
  const [info] = createResource(
    () => props.open && ([enginesConfig.primary, engineRevision(enginesConfig.primary)] as const),
    ([id]) => fetchEngineInfo(id),
  );
  const [error, setError] = createSignal<string>();

  // Threads and Hash are only known once the engine has started; ask it if it hasn't yet.
  createEffect(() => {
    if (!props.open) return;
    void loadEngines().then(() => {
      const current = engine();
      if (current && current.options.length === 0) {
        probeEngine(current.id).catch((e) => setError(errorMessage(e)));
      }
    });
  });

  const spin = (name: string) => {
    const option = engine()?.options.find((o) => o.name === name);
    return option?.type === "spin" ? option : undefined;
  };

  const setOption = (name: string, value: string | null) => {
    const current = engine();
    if (!current) return;
    setError(undefined);
    setEngineOption(current.id, name, value).catch((e) => setError(errorMessage(e)));
  };

  return (
    <Section title={`Analysis engine${engine() ? ` · ${engine()?.name}` : ""}`}>
      <Row label="Lines">
        <Segmented
          label="Engine lines"
          size="sm"
          options={Array.from({ length: MAX_MULTIPV }, (_, i) => ({
            value: String(i + 1),
            label: String(i + 1),
          }))}
          value={String(settings.multipv)}
          onChange={(value) => updateSettings({ multipv: Number(value) })}
        />
      </Row>
      <Show
        when={spin("Threads") || spin("Hash")}
        fallback={
          <p class="text-[13px] text-muted">
            {engine()?.options.length
              ? "This engine has no thread or hash settings."
              : "Waking up the engine to read its settings…"}
          </p>
        }
      >
        <Show when={spin("Threads")}>
          {(option) => (
            <SpinRow
              label="Threads"
              option={option()}
              chosen={engine()?.values.Threads}
              current={info()?.threads ?? undefined}
              auto="all cores but one"
              onChange={(value) => setOption("Threads", value)}
            />
          )}
        </Show>
        <Show when={spin("Hash")}>
          {(option) => (
            <SpinRow
              label="Hash (MB)"
              option={option()}
              chosen={engine()?.values.Hash}
              current={info()?.hashMb ?? undefined}
              auto="256 MB"
              onChange={(value) => setOption("Hash", value)}
            />
          )}
        </Show>
      </Show>
      <p class="text-[12px] text-muted">
        Changing threads or hash restarts the engine. Every other option is in the Engines section.
      </p>
      <Show when={error()}>
        <p role="alert" class="text-[13px] font-semibold text-error">
          {error()}
        </p>
      </Show>
    </Section>
  );
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

const progressText = (progress: DownloadProgress) =>
  progress.total
    ? `${megabytes(progress.downloaded)} of ${megabytes(progress.total)}`
    : megabytes(progress.downloaded);

function UpdateSettings() {
  const [restartError, setRestartError] = createSignal<string>();
  /** The state narrowed to `status`, for `<Match>`. */
  const is = <S extends UpdateState["status"]>(status: S) => {
    const current = updateState();
    return current.status === status ? (current as Extract<UpdateState, { status: S }>) : false;
  };
  const notes = (notes: string | null) => (
    <Show when={notes}>
      {(text) => (
        <p class="max-h-32 overflow-y-auto text-[13px] whitespace-pre-line text-ink/80">{text()}</p>
      )}
    </Show>
  );
  const restart = () => {
    setRestartError(undefined);
    restartApp().catch((e) => setRestartError(errorMessage(e)));
  };

  return (
    <Section title="Updates">
      <div class="flex flex-col items-start gap-2.5">
        <Switch>
          <Match when={is("available")}>
            {(s) => (
              <>
                <p class="text-[14px] font-bold">EnPawssant {s().info.version} is out</p>
                {notes(s().info.notes)}
                <button type="button" class={PRIMARY_BUTTON} onClick={() => void installUpdate()}>
                  Download and install
                </button>
              </>
            )}
          </Match>
          <Match when={is("downloading")}>
            {(s) => (
              <>
                <p class="text-[14px] font-bold">Fetching EnPawssant {s().info.version}…</p>
                <ProgressBar
                  class="w-full"
                  label="Downloading the update"
                  fraction={
                    s().progress.total
                      ? s().progress.downloaded / (s().progress.total ?? 1)
                      : undefined
                  }
                />
                <p class="text-[12px] text-muted">{progressText(s().progress)}</p>
              </>
            )}
          </Match>
          <Match when={is("ready")}>
            {(s) => (
              <>
                <p class="text-[14px] font-bold">EnPawssant {s().info.version} is installed</p>
                <p class="text-[13px] text-muted">Restart to start using it.</p>
                <button type="button" class={PRIMARY_BUTTON} onClick={restart}>
                  Restart now
                </button>
                <Show when={restartError()}>
                  <p role="alert" class="text-[13px] font-semibold text-error">
                    Couldn't restart: {restartError()}
                  </p>
                </Show>
              </>
            )}
          </Match>
          <Match when={is("error")}>
            {(s) => (
              <>
                <p role="alert" class="text-[14px] font-bold text-error">
                  {s().info ? "The update didn't install" : "Couldn't check for updates"}
                </p>
                <p class="text-[13px] text-muted">{s().message}</p>
                <button
                  type="button"
                  class={SECONDARY_BUTTON}
                  onClick={() => void (s().info ? installUpdate() : checkForUpdates())}
                >
                  Try again
                </button>
              </>
            )}
          </Match>
          <Match when={true}>
            <p class="text-[13px] text-muted">
              <Show when={appVersion()}>{(version) => <>You have EnPawssant {version()}. </>}</Show>
              {is("current")
                ? "That's the newest version."
                : "EnPawssant looks for a new version each time it opens."}
            </p>
            <button
              type="button"
              class={SECONDARY_BUTTON}
              disabled={updateState().status === "checking"}
              onClick={() => void checkForUpdates()}
            >
              {updateState().status === "checking" ? "Checking…" : "Check for updates"}
            </button>
          </Match>
        </Switch>
      </div>
    </Section>
  );
}

function SpinRow(props: {
  label: string;
  option: Extract<UciOption, { type: "spin" }>;
  /** The value the user set, if any. */
  chosen?: string;
  /** What the engine is running with. */
  current?: number;
  /** What EnPawssant picks when the user hasn't. */
  auto: string;
  onChange: (value: string | null) => void;
}) {
  const shown = () => props.chosen ?? (props.current === undefined ? "" : String(props.current));
  return (
    <Row label={props.label}>
      <div class="flex items-center gap-2">
        <input
          type="number"
          class={`${INPUT} w-28 font-mono`}
          min={props.option.min}
          max={props.option.max}
          value={shown()}
          aria-label={props.label}
          onChange={(event) => {
            const input = event.currentTarget;
            const raw = input.value.trim();
            if (raw === "") {
              props.onChange(null);
              return;
            }
            const value = Math.min(
              props.option.max,
              Math.max(props.option.min, Math.round(Number(raw))),
            );
            if (!Number.isFinite(value)) {
              input.value = shown();
              return;
            }
            input.value = String(value);
            if (String(value) !== shown()) props.onChange(String(value));
          }}
        />
        <Show
          when={props.chosen !== undefined}
          fallback={<span class="text-[12px] text-muted">Auto: {props.auto}</span>}
        >
          <button
            type="button"
            class="rounded-lg px-2 py-1 text-[12px] font-bold text-rose-strong hover:bg-blush-100"
            onClick={() => props.onChange(null)}
          >
            Use auto ({props.auto})
          </button>
        </Show>
      </div>
    </Row>
  );
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-3">
      <h3 class="border-b border-blush-200 pb-1.5 font-display text-[15px] font-semibold">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; align?: "start"; children: JSX.Element }) {
  return (
    <div
      class={`grid grid-cols-[110px_minmax(0,1fr)] gap-3 ${props.align === "start" ? "items-start" : "items-center"}`}
    >
      <span class={`text-[13px] font-bold ${props.align === "start" ? "pt-2" : ""}`}>
        {props.label}
      </span>
      <div class="min-w-0">{props.children}</div>
    </div>
  );
}

function Choice(props: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={() => props.onSelect()}
      class={`flex items-center gap-2.5 rounded-xl p-1.5 pr-3 text-left text-[13px] font-bold transition-colors ${
        props.selected ? "bg-white ring-2 ring-rose" : "bg-blush-100/70 hover:bg-blush-100"
      }`}
    >
      {props.children}
      {props.label}
    </button>
  );
}
