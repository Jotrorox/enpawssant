// The Files section: recently opened PGN files, a folder browser and a preview of the games in
// the chosen file. PGN files can also be dropped anywhere on the window (see `App.tsx`).

import { createResource, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import {
  breadcrumbs,
  type FileEntry,
  filePlaces,
  forgetFile,
  formatSize,
  type Listing,
  listFolder,
  pickFolder,
  readPgnFile,
  recentFiles,
  relativeTime,
  rememberFile,
} from "../chess/files";
import type { ImportedGame, OpenedPgn } from "../chess/pgn";
import { ClockIcon, CloseIcon, DatabaseIcon, FileIcon, FolderIcon, UpIcon } from "./Icons";
import { GamePicker } from "./PgnDialogs";
import {
  Card,
  CardTitle,
  EmptyState,
  IconButton,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  ViewHeader,
} from "./ui";

const FOLDER_KEY = "enpawssant.filesFolder";

/** Whether the file holds exactly one game that was read in full, so saving it can replace it. */
const isWholeFile = (file: OpenedPgn) =>
  file.games.length === 1 &&
  file.errors.length === 0 &&
  !file.truncated &&
  file.games[0].warnings.length === 0;

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

type FilesViewProps = {
  /** Opens games from a file in tabs; `path` is given when the file holds just that game. */
  onOpenGames: (games: ImportedGame[], path?: string) => void;
  /** Imports files into the game database. */
  onImport: (paths: string[]) => void;
  importing: boolean;
};

export function FilesView(props: FilesViewProps) {
  const [places] = createResource(filePlaces);
  const [folder, setFolder] = createSignal<string>();
  const [listing, setListing] = createSignal<Listing>();
  const [listError, setListError] = createSignal<string>();
  const [selected, setSelected] = createSignal<string>();
  const [opened, setOpened] = createSignal<OpenedPgn>();
  const [openError, setOpenError] = createSignal<string>();
  const [loadingFile, setLoadingFile] = createSignal(false);

  const browse = async (path: string) => {
    setListError(undefined);
    try {
      const result = await listFolder(path);
      setListing(result);
      setFolder(result.path);
      try {
        localStorage.setItem(FOLDER_KEY, result.path);
      } catch {
        // Not remembering the folder is fine.
      }
    } catch (e) {
      setListError(errorMessage(e));
    }
  };

  onMount(async () => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(FOLDER_KEY);
    } catch {
      // Fall back to a place below.
    }
    if (saved) {
      await browse(saved);
      if (!listError()) return;
    }
    const start = await filePlaces().catch(() => []);
    const documents = start.find((place) => place.name === "Documents") ?? start[0];
    if (documents) await browse(documents.path);
  });

  /** Reads a file and shows its games. */
  const openFile = async (path: string) => {
    setSelected(path);
    setOpenError(undefined);
    setLoadingFile(true);
    try {
      const file = await readPgnFile(path);
      if (selected() !== path) return;
      setOpened(file);
      rememberFile(file);
    } catch (e) {
      if (selected() !== path) return;
      setOpened(undefined);
      setOpenError(errorMessage(e));
    } finally {
      if (selected() === path) setLoadingFile(false);
    }
  };

  const chooseFolder = async () => {
    const path = await pickFolder().catch((e) => {
      setListError(errorMessage(e));
      return null;
    });
    if (path) await browse(path);
  };

  return (
    <div class="flex h-full min-h-0 flex-col gap-3.5 p-3.5 pl-[18px]">
      <ViewHeader
        title="Files"
        subtitle="Open PGN files from your computer, or drop them anywhere on the window."
      >
        <button type="button" class={SECONDARY_BUTTON} onClick={() => void chooseFolder()}>
          <FolderIcon class="size-[18px]" />
          Choose folder…
        </button>
      </ViewHeader>

      <div class="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)_minmax(0,1fr)] gap-3.5">
        <div class="flex min-h-0 flex-col gap-3.5">
          <Card class="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-2">
            <div class="mb-1.5 flex items-center gap-2 px-1.5">
              <ClockIcon class="size-4 text-rose" />
              <CardTitle>Recent</CardTitle>
            </div>
            <Show
              when={recentFiles().length > 0}
              fallback={
                <p class="px-1.5 pb-2 text-[13px] text-muted">
                  Files you open show up here, so they're one click away next time.
                </p>
              }
            >
              <ul class="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                <For each={recentFiles()}>
                  {(file) => (
                    <li class="group relative">
                      <button
                        type="button"
                        title={file.path}
                        aria-current={selected() === file.path ? "true" : undefined}
                        onClick={() => void openFile(file.path)}
                        class={`flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-1.5 pr-8 text-left transition-colors ${
                          selected() === file.path ? "bg-blush-100" : "hover:bg-blush-100/60"
                        }`}
                      >
                        <FileIcon class="size-[18px] shrink-0 text-ink/70" />
                        <span class="min-w-0">
                          <span class="block truncate text-[13px] font-bold">{file.name}</span>
                          <span class="block truncate text-[11px] text-muted">
                            {file.games} {file.games === 1 ? "game" : "games"} ·{" "}
                            {relativeTime(file.openedAt)}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Forget ${file.name}`}
                        title="Remove from recent files"
                        onClick={() => forgetFile(file.path)}
                        class="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-ink/50 opacity-0 group-hover:opacity-100 hover:bg-blush-200 hover:text-ink focus-visible:opacity-100"
                      >
                        <CloseIcon class="size-3.5" />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Card>

          <Card class="shrink-0 px-3 pt-3 pb-2">
            <div class="mb-1.5 px-1.5">
              <CardTitle>Places</CardTitle>
            </div>
            <ul>
              <For each={places() ?? []}>
                {(place) => (
                  <li>
                    <button
                      type="button"
                      title={place.path}
                      onClick={() => void browse(place.path)}
                      class={`flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-[13px] font-bold transition-colors ${
                        folder() === place.path ? "bg-blush-100" : "hover:bg-blush-100/60"
                      }`}
                    >
                      <FolderIcon class="size-[18px] shrink-0 text-rose" />
                      {place.name}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Card>
        </div>

        <Card class="flex min-h-0 flex-col px-3 pt-3 pb-2">
          <div class="mb-2 flex min-w-0 items-center gap-1 px-1">
            <IconButton
              label="Up one folder"
              class="size-8 shrink-0"
              disabled={!listing()?.parent}
              onClick={() => {
                const parent = listing()?.parent;
                if (parent) void browse(parent);
              }}
            >
              <UpIcon class="size-[18px]" />
            </IconButton>
            <nav
              aria-label="Folder path"
              class="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[13px] whitespace-nowrap"
              dir="rtl"
            >
              {/* Right-to-left keeps the current folder visible when the path is long. */}
              <span dir="ltr" class="flex items-center gap-0.5">
                <For each={folder() ? breadcrumbs(folder() ?? "") : []}>
                  {(crumb, index) => (
                    <>
                      <Show when={index() > 0 && crumb.name !== "/"}>
                        <span class="text-ink/40">›</span>
                      </Show>
                      <button
                        type="button"
                        onClick={() => void browse(crumb.path)}
                        class={`rounded-md px-1 py-0.5 hover:bg-blush-100 ${
                          crumb.path === folder() ? "font-bold" : "text-ink/70"
                        }`}
                      >
                        {crumb.name}
                      </button>
                    </>
                  )}
                </For>
              </span>
            </nav>
          </div>

          <Switch>
            <Match when={listError()}>
              {(error) => <EmptyState class="text-error">{error()}</EmptyState>}
            </Match>
            <Match when={!listing()}>
              <EmptyState>Mochi is sniffing around the folders…</EmptyState>
            </Match>
            <Match when={listing()?.entries.length === 0}>
              <EmptyState>No folders or PGN files in here.</EmptyState>
            </Match>
            <Match when={listing()}>
              {(current) => (
                <ul class="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                  <For each={current().entries}>
                    {(entry) => (
                      <EntryRow
                        entry={entry}
                        selected={selected() === entry.path}
                        onActivate={() =>
                          entry.kind === "folder"
                            ? void browse(entry.path)
                            : void openFile(entry.path)
                        }
                      />
                    )}
                  </For>
                </ul>
              )}
            </Match>
          </Switch>
        </Card>

        <Card class="flex min-h-0 flex-col gap-2 px-4 pt-3 pb-4">
          <Switch>
            <Match when={!selected()}>
              <EmptyState class="flex-1 gap-1">
                <span class="font-bold text-ink">No file chosen</span>
                <span>
                  Pick a PGN file to see its games, then open them or add them to your database.
                </span>
              </EmptyState>
            </Match>
            <Match when={loadingFile()}>
              <EmptyState class="flex-1">Reading the file…</EmptyState>
            </Match>
            <Match when={openError()}>
              {(error) => (
                <EmptyState class="flex-1 gap-3">
                  <span class="text-error">{error()}</span>
                  <Show when={recentFiles().some((file) => file.path === selected())}>
                    <button
                      type="button"
                      class={SECONDARY_BUTTON}
                      onClick={() => {
                        const path = selected();
                        if (path) forgetFile(path);
                        setSelected(undefined);
                      }}
                    >
                      Remove from recent files
                    </button>
                  </Show>
                </EmptyState>
              )}
            </Match>
            <Match when={opened()}>
              {(file) => (
                <>
                  <div class="flex min-w-0 items-center gap-2">
                    <FileIcon class="size-5 shrink-0 text-rose" />
                    <h2
                      class="min-w-0 truncate font-display text-[15px] font-semibold"
                      title={file().path}
                    >
                      {file().name}
                    </h2>
                    <button
                      type="button"
                      class={`${PRIMARY_BUTTON} ml-auto h-8 px-3 text-[13px]`}
                      disabled={props.importing}
                      title="Add every game in this file to your game database"
                      onClick={() => props.onImport([file().path])}
                    >
                      <DatabaseIcon class="size-4" />
                      Add to database
                    </button>
                  </div>
                  <div class="flex min-h-0 flex-1 flex-col gap-2">
                    <GamePicker
                      parsed={{ ...file(), name: undefined }}
                      onOpen={(games) =>
                        props.onOpenGames(games, isWholeFile(file()) ? file().path : undefined)
                      }
                    />
                  </div>
                </>
              )}
            </Match>
          </Switch>
        </Card>
      </div>
    </div>
  );
}

function EntryRow(props: { entry: FileEntry; selected: boolean; onActivate: () => void }) {
  const folder = () => props.entry.kind === "folder";
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onActivate()}
        aria-current={props.selected ? "true" : undefined}
        class={`flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors ${
          props.selected ? "bg-blush-100" : "hover:bg-blush-100/60"
        }`}
      >
        <Show when={folder()} fallback={<FileIcon class="size-[18px] shrink-0 text-ink/70" />}>
          <FolderIcon class="size-[18px] shrink-0 text-rose" />
        </Show>
        <span
          class={`min-w-0 flex-1 truncate text-[13px] ${folder() ? "font-semibold" : "font-bold"}`}
        >
          {props.entry.name}
        </span>
        <Show when={!folder()}>
          <span class="shrink-0 font-mono text-[11px] text-muted">
            {formatSize(props.entry.size)}
          </span>
        </Show>
      </button>
    </li>
  );
}
