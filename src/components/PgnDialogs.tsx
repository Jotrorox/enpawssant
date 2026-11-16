import { createEffect, createResource, createSignal, For, type JSX, Show } from "solid-js";
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
import { CheckIcon, CloseIcon, CopyIcon, ExportIcon, FolderIcon, ImportIcon } from "./Icons";
import { EmptyState, IconButton } from "./ui";

const PRIMARY =
  "flex h-9 items-center gap-2 rounded-xl bg-blush-400 px-4 text-[14px] font-bold whitespace-nowrap text-ink shadow-[inset_0_-2px_0_rgb(224_112_143/0.6)] transition-colors hover:bg-blush-300 disabled:opacity-50 disabled:hover:bg-blush-400";
const SECONDARY =
  "flex h-9 items-center gap-2 rounded-xl bg-blush-100 px-4 text-[14px] font-bold whitespace-nowrap text-ink transition-colors hover:bg-blush-200 disabled:opacity-50";

/** Rejections from Tauri commands are plain strings; anything else is an unexpected error. */
const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

function Modal(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  let dialog!: HTMLDialogElement;
  createEffect(() => {
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  });

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog natively.
    <dialog
      ref={dialog}
      aria-label={props.title}
      onClose={() => props.onClose()}
      // Clicks on the backdrop land on the dialog element itself.
      onClick={(event) => event.target === dialog && dialog.close()}
      class="m-auto w-[min(640px,calc(100vw-32px))] rounded-[20px] border border-blush-200 bg-blush-50 text-ink shadow-card backdrop:bg-plum/30"
    >
      <div class="flex max-h-[calc(100vh-64px)] flex-col gap-3 p-5">
        <div class="flex items-center">
          <h2 class="font-display text-[17px] font-semibold">{props.title}</h2>
          <IconButton label="Close" class="ml-auto" onClick={() => dialog.close()}>
            <CloseIcon class="size-4" />
          </IconButton>
        </div>
        {props.children}
      </div>
    </dialog>
  );
}

type ImportDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Opens the chosen games, e.g. in new tabs. */
  onOpen: (games: ImportedGame[]) => void;
};

/** More games than this can't be opened all at once, to keep the tab bar usable. */
const MAX_OPEN_ALL = 12;

export function ImportDialog(props: ImportDialogProps) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [result, setResult] = createSignal<ParsedPgn & { name?: string }>();

  // Start fresh every time the dialog opens.
  createEffect(() => {
    if (!props.open) return;
    setText("");
    setError(undefined);
    setResult(undefined);
  });

  const open = (games: ImportedGame[]) => {
    props.onOpen(games);
    props.onClose();
  };

  const handle = (parsed: ParsedPgn & { name?: string }) => {
    if (parsed.games.length === 0) {
      setError(parsed.errors[0] ?? "No games found. Is this a PGN?");
      return;
    }
    const [only] = parsed.games;
    if (parsed.games.length === 1 && parsed.errors.length === 0 && only.warnings.length === 0) {
      open([only]);
      return;
    }
    setResult(parsed);
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
    <Modal open={props.open} title="Import PGN" onClose={props.onClose}>
      <Show
        when={result()}
        fallback={
          <>
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
                class={SECONDARY}
                disabled={busy()}
                onClick={() => run(openPgnFile)}
              >
                <FolderIcon class="size-[18px]" />
                Open file…
              </button>
              <button
                type="button"
                class={`${PRIMARY} ml-auto`}
                disabled={busy() || text().trim() === ""}
                onClick={() => run(() => parsePgn(text()))}
              >
                <ImportIcon class="size-[18px]" />
                Import
              </button>
            </div>
          </>
        }
      >
        {(parsed) => <GamePicker parsed={parsed()} onOpen={open} />}
      </Show>
    </Modal>
  );
}

function GamePicker(props: {
  parsed: ParsedPgn & { name?: string };
  onOpen: (games: ImportedGame[]) => void;
}) {
  const count = () => props.parsed.games.length;
  return (
    <>
      <p class="text-[13px] text-muted">
        {props.parsed.name ? `${props.parsed.name}: ` : ""}
        {count()} {count() === 1 ? "game" : "games"}
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
      <Show when={count() > 1 && count() <= MAX_OPEN_ALL}>
        <button
          type="button"
          class={`${PRIMARY} self-end`}
          onClick={() => props.onOpen(props.parsed.games)}
        >
          Open all {count()} games
        </button>
      </Show>
    </>
  );
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
      <button type="button" class={SECONDARY} onClick={() => props.onOpen()}>
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
        <button type="button" class={`${SECONDARY} ml-auto`} disabled={!pgn()} onClick={copy}>
          <CopyIcon class="size-[18px]" />
          Copy
        </button>
        <button type="button" class={PRIMARY} disabled={!pgn()} onClick={save}>
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
