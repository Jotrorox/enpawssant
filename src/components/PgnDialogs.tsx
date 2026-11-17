import { createEffect, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { addGames, databaseChanged } from "../chess/database";
import { rememberFile } from "../chess/files";
import { type OnlineSite, SITE_NAMES } from "../chess/online";
import {
  exportPgn,
  header,
  type ImportedGame,
  openPgnFile,
  type ParsedPgn,
  parsePgn,
  savePgnFile,
} from "../chess/pgn";
import { type GameSession, gameTitle } from "../game/session";
import { CheckIcon, CopyIcon, DatabaseIcon, ExportIcon, FolderIcon, ImportIcon } from "./Icons";
import { type FetchedGames, OnlineImport } from "./OnlineImport";
import { EmptyState, Modal, PRIMARY_BUTTON, SECONDARY_BUTTON, Segmented } from "./ui";

/** Rejections from Tauri commands are plain strings; anything else is an unexpected error. */
const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

export type ImportSource = "pgn" | OnlineSite;

const SOURCES = [
  { value: "pgn", label: "PGN" },
  { value: "lichess", label: "Lichess" },
  { value: "chesscom", label: "Chess.com" },
] as const;

type ImportDialogProps = {
  open: boolean;
  /** Games already read, e.g. from a dropped file: the dialog starts with the game picker. */
  preset?: ParsedPgn & { name?: string };
  /** The tab to start on; PGN unless given. */
  source?: ImportSource;
  onClose: () => void;
  /**
   * Opens the chosen games, e.g. in new tabs. `player` is whose games they are, when they were
   * fetched from a site, so the board can face their way.
   */
  onOpen: (games: ImportedGame[], player?: string) => void;
};

/** Games to pick from, and where they came from. */
type Picked = ParsedPgn & { name?: string; fetched?: FetchedGames };

/** More games than this can't be opened all at once, to keep the tab bar usable. */
const MAX_OPEN_ALL = 12;

export function ImportDialog(props: ImportDialogProps) {
  return (
    <Modal open={props.open} title="Import games" onClose={props.onClose}>
      {/* Mounted afresh every time the dialog opens. */}
      <Show when={props.open}>
        <ImportContent {...props} />
      </Show>
    </Modal>
  );
}

function ImportContent(props: ImportDialogProps) {
  const [source, setSource] = createSignal<ImportSource>(props.source ?? "pgn");
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [result, setResult] = createSignal<Picked | undefined>(props.preset);

  const open = (games: ImportedGame[]) => {
    props.onOpen(games, result()?.fetched?.username);
    props.onClose();
  };

  const isSimple = (parsed: ParsedPgn) =>
    parsed.games.length === 1 &&
    parsed.errors.length === 0 &&
    parsed.games[0].warnings.length === 0;

  const handle = (parsed: ParsedPgn & { name?: string }) => {
    if (parsed.games.length === 0) {
      setError(parsed.errors[0] ?? "No games found. Is this a PGN?");
    } else if (isSimple(parsed)) {
      open(parsed.games);
    } else {
      setResult(parsed);
    }
  };

  const handleFetched = (fetched: FetchedGames) => {
    if (isSimple(fetched)) {
      props.onOpen(fetched.games, fetched.username);
      props.onClose();
    } else {
      setResult({
        ...fetched,
        name: `${fetched.username} on ${SITE_NAMES[fetched.site]}`,
        fetched,
      });
    }
  };

  const run = async (read: () => Promise<(ParsedPgn & { name?: string }) | null>) => {
    setBusy(true);
    setError(undefined);
    try {
      const parsed = await read();
      if (parsed) handle(parsed);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Hidden rather than unmounted while picking, so going back keeps what was entered. */}
      <div class={`flex flex-col gap-3 ${result() ? "hidden" : ""}`}>
        <Segmented label="Import from" options={SOURCES} value={source()} onChange={setSource} />
        <Switch>
          <Match when={source() === "pgn"}>
            <textarea
              value={text()}
              onInput={(event) => setText(event.currentTarget.value)}
              placeholder={'[Event "Sunday nap"]\n\n1. e4 e5 2. Nf3 Nc6 *'}
              aria-label="PGN text"
              spellcheck={false}
              class="selectable h-56 resize-none rounded-xl border border-blush-200 bg-white p-3 font-mono text-[12px] leading-relaxed outline-none placeholder:text-ink/50 focus:border-rose"
            />
            <Show when={error()}>
              <p role="alert" class="text-[13px] font-semibold text-error">
                {error()}
              </p>
            </Show>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class={SECONDARY_BUTTON}
                disabled={busy()}
                onClick={() =>
                  run(async () => {
                    const opened = await openPgnFile();
                    if (opened) rememberFile(opened);
                    return opened;
                  })
                }
              >
                <FolderIcon class="size-[18px]" />
                Open file…
              </button>
              <button
                type="button"
                class={`${PRIMARY_BUTTON} ml-auto`}
                disabled={busy() || text().trim() === ""}
                onClick={() => run(() => parsePgn(text()))}
              >
                <ImportIcon class="size-[18px]" />
                Import
              </button>
            </div>
          </Match>
          <Match when={source() === "lichess"}>
            <OnlineImport site="lichess" onFetched={handleFetched} />
          </Match>
          <Match when={source() === "chesscom"}>
            <OnlineImport site="chesscom" onFetched={handleFetched} />
          </Match>
        </Switch>
      </div>
      <Show when={result()}>
        {(parsed) => (
          <GamePicker
            parsed={parsed()}
            onOpen={open}
            onBack={props.preset ? undefined : () => setResult(undefined)}
            databaseSource={(() => {
              const fetched = parsed().fetched;
              return fetched && SITE_NAMES[fetched.site];
            })()}
          />
        )}
      </Show>
    </>
  );
}

export function GamePicker(props: {
  parsed: ParsedPgn & { name?: string };
  onOpen: (games: ImportedGame[]) => void;
  /** Shows a button that goes back to choosing what to import. */
  onBack?: () => void;
  /** Shows a button that adds every game to the database, with this as their source. */
  databaseSource?: string;
}) {
  const count = () => props.parsed.games.length;
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal<{ ok: boolean; message: string }>();

  const addAll = async (source: string) => {
    setSaving(true);
    try {
      const added = await addGames(props.parsed.games, source);
      databaseChanged();
      const parts = [`Added ${plural(added.imported, "game")} to the database`];
      if (added.duplicates > 0) parts.push(`${plural(added.duplicates, "game")} already there`);
      if (added.failed > 0) parts.push(`${plural(added.failed, "game")} couldn't be saved`);
      setSaved({ ok: added.imported > 0 || added.failed === 0, message: `${parts.join(", ")}.` });
    } catch (e) {
      setSaved({ ok: false, message: `Mochi couldn't save the games: ${errorMessage(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p class="text-[13px] text-muted">
        {props.parsed.name ? `${props.parsed.name}: ` : ""}
        {plural(count(), "game")}
        {props.parsed.truncated ? " (only the first ones were read)" : ""}
      </p>
      <Show when={props.parsed.errors.length > 0}>
        <ul role="alert" class="text-[13px] font-semibold text-error">
          <For each={props.parsed.errors}>{(error) => <li>{error}</li>}</For>
        </ul>
      </Show>
      <ul class="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto px-1">
        <For each={props.parsed.games}>
          {(game) => <GameRow game={game} onOpen={() => props.onOpen([game])} />}
        </For>
      </ul>
      <Show when={saved()}>
        {(status) => (
          <p
            role="status"
            class={`flex items-center gap-1.5 text-[13px] font-semibold ${
              status().ok ? "text-nag-good" : "text-error"
            }`}
          >
            <Show when={status().ok}>
              <CheckIcon class="size-4" />
            </Show>
            {status().message}
          </p>
        )}
      </Show>
      <Show when={props.onBack || props.databaseSource || count() > 1}>
        <div class="flex items-center gap-2">
          <Show when={props.onBack}>
            {(back) => (
              <button type="button" class={SECONDARY_BUTTON} onClick={() => back()()}>
                Back
              </button>
            )}
          </Show>
          <Show when={props.databaseSource}>
            {(source) => (
              <button
                type="button"
                class={`${SECONDARY_BUTTON} ml-auto`}
                disabled={saving() || saved()?.ok}
                onClick={() => void addAll(source())}
              >
                <DatabaseIcon class="size-[18px]" />
                {saving() ? "Adding…" : `Add ${count() === 1 ? "it" : "all"} to the database`}
              </button>
            )}
          </Show>
          <Show when={count() > 1 && count() <= MAX_OPEN_ALL}>
            <button
              type="button"
              class={`${PRIMARY_BUTTON} ${props.databaseSource ? "" : "ml-auto"}`}
              onClick={() => props.onOpen(props.parsed.games)}
            >
              Open all {count()} games
            </button>
          </Show>
        </div>
      </Show>
    </>
  );
}

/** `1 game`, `20 games`. */
function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? noun : `${noun}s`}`;
}

function GameRow(props: { game: ImportedGame; onOpen: () => void }) {
  const details = () =>
    [
      header(props.game, "Event"),
      header(props.game, "Date"),
      header(props.game, "Result"),
      `${Math.ceil(props.game.moves.length / 2)} moves`,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <li class="flex items-center gap-3 rounded-xl bg-white px-3 py-2 ring-1 ring-blush-200">
      <div class="min-w-0 flex-1">
        <p class="truncate text-[14px] font-bold">{gameTitle(props.game)}</p>
        <p class="truncate text-[12px] text-muted">{details()}</p>
        <For each={props.game.warnings}>
          {(warning) => <p class="text-[12px] font-semibold text-nag-dubious">{warning}</p>}
        </For>
      </div>
      <button type="button" class={SECONDARY_BUTTON} onClick={() => props.onOpen()}>
        Open
      </button>
    </li>
  );
}

type ExportDialogProps = {
  open: boolean;
  session?: GameSession;
  onClose: () => void;
};

export function ExportDialog(props: ExportDialogProps) {
  const [pgn] = createResource(
    () => props.open && props.session,
    (session) => exportPgn(session.toPgn()),
  );
  const [status, setStatus] = createSignal<{ ok: boolean; message: string }>();

  createEffect(() => {
    if (props.open) setStatus(undefined);
  });

  const copy = async () => {
    const text = pgn();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ ok: true, message: "Copied to the clipboard." });
    } catch (e) {
      setStatus({ ok: false, message: `Could not copy: ${errorMessage(e)}` });
    }
  };

  const save = async () => {
    const session = props.session;
    if (!session) return;
    const game = session.toPgn();
    try {
      const name = await savePgnFile(game, `${fileSafe(gameTitle(game))}.pgn`);
      if (name) setStatus({ ok: true, message: `Saved ${name}.` });
    } catch (e) {
      setStatus({ ok: false, message: `Could not save: ${errorMessage(e)}` });
    }
  };

  return (
    <Modal open={props.open} title="Export PGN" onClose={props.onClose}>
      <Show
        when={!pgn.error}
        fallback={
          <EmptyState class="text-error">
            This game can't be written as PGN: {errorMessage(pgn.error)}
          </EmptyState>
        }
      >
        <textarea
          readOnly
          value={pgn() ?? ""}
          aria-label="PGN"
          spellcheck={false}
          class="selectable h-64 resize-none rounded-xl border border-blush-200 bg-white p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-rose"
        />
      </Show>
      <div class="flex items-center gap-2">
        <Show when={status()}>
          {(status) => (
            <p
              role="status"
              class={`flex items-center gap-1.5 text-[13px] font-semibold ${
                status().ok ? "text-nag-good" : "text-error"
              }`}
            >
              <Show when={status().ok}>
                <CheckIcon class="size-4" />
              </Show>
              {status().message}
            </p>
          )}
        </Show>
        <button
          type="button"
          class={`${SECONDARY_BUTTON} ml-auto`}
          disabled={!pgn()}
          onClick={copy}
        >
          <CopyIcon class="size-[18px]" />
          Copy
        </button>
        <button type="button" class={PRIMARY_BUTTON} disabled={!pgn()} onClick={save}>
          <ExportIcon class="size-[18px]" />
          Save as…
        </button>
      </div>
    </Modal>
  );
}

/** A file name without characters that file systems reject. */
function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "game";
}
