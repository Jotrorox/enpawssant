// The Database section: search the local game database by text, player, opening, result or
// position, open games in tabs, and fill it from PGN files or the board.

import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import {
  cancelImport,
  clearDatabase,
  completeFen,
  databaseChanged,
  databaseStats,
  databaseVersion,
  deleteGame,
  formatResult,
  type GameSummary,
  importProgress,
  looksLikeFen,
  type SearchQuery,
  type SearchResult,
  searchGames,
} from "../chess/database";
import { formatSize } from "../chess/files";
import { DatabaseIcon, DownloadIcon, ImportIcon, PlusIcon, SearchIcon, TrashIcon } from "./Icons";
import {
  Card,
  EmptyState,
  IconButton,
  INPUT,
  PRIMARY_BUTTON,
  ProgressBar,
  SECONDARY_BUTTON,
  Segmented,
  ViewHeader,
} from "./ui";

const PAGE = 100;
const DEBOUNCE_MS = 200;

const RESULTS = [
  { value: "", label: "Any" },
  { value: "1-0", label: "1-0" },
  { value: "1/2-1/2", label: "½-½" },
  { value: "0-1", label: "0-1" },
] as const;

type ResultFilter = (typeof RESULTS)[number]["value"];

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

/** A search handed over from the title bar; `nonce` makes repeating the same search count. */
export type DatabaseRequest = { text: string; nonce: number };

type DatabaseViewProps = {
  request?: DatabaseRequest;
  /** The position on the board, if a game is open. */
  currentFen?: string;
  /** Whether a game is open to add. */
  canAddCurrent: boolean;
  onAddCurrent: () => void;
  onImportFiles: () => void;
  /** Opens the import dialog on its Lichess and Chess.com tabs. */
  onImportOnline: () => void;
  onOpenGame: (id: number, ply: number | null) => void;
  notify: (message: string, tone?: "info" | "error") => void;
};

export function DatabaseView(props: DatabaseViewProps) {
  const [text, setText] = createSignal("");
  const [player, setPlayer] = createSignal("");
  const [opening, setOpening] = createSignal("");
  const [result, setResult] = createSignal<ResultFilter>("");
  const [fen, setFen] = createSignal("");
  const [page, setPage] = createSignal<SearchResult>();
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  const [stats] = createResource(databaseVersion, () => databaseStats());

  // Searches from the title bar fill the text or the position field.
  createEffect(
    on(
      () => props.request,
      (request) => {
        if (!request) return;
        if (looksLikeFen(request.text)) {
          setFen(completeFen(request.text));
          setText("");
        } else {
          setText(request.text);
          setFen("");
        }
        setPlayer("");
        setOpening("");
        setResult("");
      },
    ),
  );

  const query = (offset: number): SearchQuery => ({
    text: text(),
    player: player(),
    opening: opening(),
    result: result(),
    // A half-typed FEN doesn't filter yet; the field turns red instead.
    fen: looksLikeFen(fen()) ? completeFen(fen()) : undefined,
    offset,
    limit: PAGE,
  });

  let request = 0;
  const run = async (offset: number) => {
    const current = ++request;
    setLoading(true);
    try {
      const found = await searchGames(query(offset));
      if (current !== request) return;
      setError(undefined);
      setPage((previous) =>
        offset > 0 && previous
          ? { games: [...previous.games, ...found.games], total: found.total }
          : found,
      );
    } catch (e) {
      if (current === request) setError(errorMessage(e));
    } finally {
      if (current === request) setLoading(false);
    }
  };

  // Search again whenever a filter changes or games are added or removed.
  createEffect(() => {
    query(0);
    databaseVersion();
    const timer = setTimeout(() => void run(0), DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  const remove = async (game: GameSummary) => {
    try {
      await deleteGame(game.id);
      databaseChanged();
    } catch (e) {
      props.notify(`Mochi couldn't delete the game: ${errorMessage(e)}`, "error");
    }
  };

  const clearAll = async () => {
    const count = stats()?.games ?? 0;
    if (!window.confirm(`Delete all ${count.toLocaleString("en-US")} games from the database?`)) {
      return;
    }
    try {
      await clearDatabase();
      databaseChanged();
      props.notify("The database is empty again.");
    } catch (e) {
      props.notify(`Mochi couldn't clear the database: ${errorMessage(e)}`, "error");
    }
  };

  const filtered = () =>
    [text(), player(), opening(), result(), fen()].some((value) => value.trim() !== "");
  const resetFilters = () => {
    setText("");
    setPlayer("");
    setOpening("");
    setResult("");
    setFen("");
  };

  return (
    <div class="flex h-full min-h-0 flex-col gap-3.5 p-3.5 pl-[18px]">
      <ViewHeader
        title="Game database"
        subtitle={
          <Show when={stats()} fallback="Your games, on your computer.">
            {(info) => (
              <span title={info().path}>
                {info().games.toLocaleString("en-US")} {info().games === 1 ? "game" : "games"}, on
                your computer
              </span>
            )}
          </Show>
        }
      >
        <Show when={(stats()?.games ?? 0) > 0}>
          <IconButton label="Delete all games" onClick={() => void clearAll()}>
            <TrashIcon />
          </IconButton>
        </Show>
        <button
          type="button"
          class={SECONDARY_BUTTON}
          disabled={!props.canAddCurrent}
          title={
            props.canAddCurrent ? "Save the game on the board" : "Open a game on the board first"
          }
          onClick={() => props.onAddCurrent()}
        >
          <PlusIcon class="size-[18px]" />
          Add board game
        </button>
        <button type="button" class={SECONDARY_BUTTON} onClick={() => props.onImportOnline()}>
          <DownloadIcon class="size-[18px]" />
          From Lichess or Chess.com…
        </button>
        <button
          type="button"
          class={PRIMARY_BUTTON}
          disabled={!!importProgress()}
          onClick={() => props.onImportFiles()}
        >
          <ImportIcon class="size-[18px]" />
          Import PGN…
        </button>
      </ViewHeader>

      <Show when={importProgress()}>
        {(progress) => (
          <Card class="flex shrink-0 items-center gap-4 px-[18px] py-3">
            <div class="min-w-0 flex-1">
              <p class="mb-1.5 truncate text-[13px]">
                <span class="font-bold">Importing {progress().file}</span>
                <span class="text-muted">
                  {" "}
                  · {progress().imported.toLocaleString("en-US")} games
                  {progress().duplicates > 0
                    ? `, ${progress().duplicates.toLocaleString("en-US")} already there`
                    : ""}
                  {progress().filesTotal > 1
                    ? ` · file ${progress().filesDone + 1} of ${progress().filesTotal}`
                    : ""}
                  {" · "}
                  {formatSize(progress().bytesRead)} of {formatSize(progress().bytesTotal)}
                </span>
              </p>
              <ProgressBar
                label="Import progress"
                fraction={
                  progress().bytesTotal > 0
                    ? progress().bytesRead / progress().bytesTotal
                    : undefined
                }
              />
            </div>
            <button type="button" class={SECONDARY_BUTTON} onClick={() => void cancelImport()}>
              Stop
            </button>
          </Card>
        )}
      </Show>

      <Card class="shrink-0 px-[18px] py-3.5">
        <div class="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
          <label class="relative flex min-w-0 items-center">
            <SearchIcon class="pointer-events-none absolute left-3 size-4 text-ink/60" />
            <input
              type="search"
              value={text()}
              onInput={(event) => setText(event.currentTarget.value)}
              placeholder="Players, events, openings…"
              aria-label="Search games"
              class={`${INPUT} w-full pl-9`}
            />
          </label>
          <input
            type="search"
            value={player()}
            onInput={(event) => setPlayer(event.currentTarget.value)}
            placeholder="Player (either colour)"
            aria-label="Player"
            class={INPUT}
          />
          <input
            type="search"
            value={opening()}
            onInput={(event) => setOpening(event.currentTarget.value)}
            placeholder="Opening or ECO, e.g. B90"
            aria-label="Opening"
            class={INPUT}
          />
        </div>
        <div class="mt-2.5 flex items-center gap-2.5">
          <input
            type="search"
            value={fen()}
            onInput={(event) => setFen(event.currentTarget.value)}
            placeholder="Position (FEN): games that reached it, by any move order"
            aria-label="Position as FEN"
            spellcheck={false}
            class={`${INPUT} min-w-0 flex-1 font-mono text-[12px] ${
              fen().trim() && !looksLikeFen(fen()) ? "border-error" : ""
            }`}
          />
          <button
            type="button"
            class={`${SECONDARY_BUTTON} h-9`}
            disabled={!props.currentFen}
            title="Search for the position on the board"
            onClick={() => setFen(props.currentFen ?? "")}
          >
            Board position
          </button>
          <Segmented
            size="sm"
            label="Result"
            options={RESULTS}
            value={result()}
            onChange={setResult}
            class="shrink-0 border border-blush-200/80 bg-blush-50"
          />
        </div>
      </Card>

      <Card class="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-2">
        <Switch>
          <Match when={error()}>
            {(message) => <EmptyState class="m-2 text-error">{message()}</EmptyState>}
          </Match>
          <Match when={stats()?.games === 0}>
            <EmptyState class="m-2 flex-1 gap-2">
              <DatabaseIcon class="size-8 text-rose" />
              <span class="font-bold text-ink">The database is empty</span>
              <span>
                Import PGN files or your games from Lichess and Chess.com, drop files onto this
                window or save the game on the board. Games are indexed by position, so you can find
                every game that reached a position.
              </span>
            </EmptyState>
          </Match>
          <Match when={page()?.games.length === 0}>
            <EmptyState class="m-2 flex-1 gap-2">
              <span>No games match.</span>
              <Show when={filtered()}>
                <button type="button" class={SECONDARY_BUTTON} onClick={resetFilters}>
                  Clear the filters
                </button>
              </Show>
            </EmptyState>
          </Match>
          <Match when={page()}>
            {(current) => (
              <>
                <p class="px-2.5 pb-1 text-[12px] text-muted" aria-live="polite">
                  {current().total.toLocaleString("en-US")}{" "}
                  {current().total === 1 ? "game" : "games"}
                  {looksLikeFen(fen()) ? " reached this position" : ""}
                  {loading() ? " · searching…" : ""}
                </p>
                <div class="min-h-0 flex-1 overflow-y-auto">
                  <table class="w-full table-fixed border-separate border-spacing-y-0.5 text-[13px]">
                    <thead class="sticky top-0 z-10 bg-white">
                      <tr class="text-left text-[11px] font-bold tracking-[0.08em] text-ink/70 uppercase">
                        <th class="w-[22%] py-1.5 pl-2.5">White</th>
                        <th class="w-[22%] py-1.5">Black</th>
                        <th class="w-[56px] py-1.5">Result</th>
                        <th class="w-[92px] py-1.5">Date</th>
                        <th class="py-1.5">Opening · Event</th>
                        <th class="w-[56px] py-1.5 text-right">Moves</th>
                        <th class="w-[40px]" aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      <For each={current().games}>
                        {(game) => (
                          <GameRowView
                            game={game}
                            onOpen={() => props.onOpenGame(game.id, game.ply)}
                            onDelete={() => void remove(game)}
                          />
                        )}
                      </For>
                    </tbody>
                  </table>
                  <Show when={current().games.length < current().total}>
                    <div class="flex justify-center py-2">
                      <button
                        type="button"
                        class={SECONDARY_BUTTON}
                        disabled={loading()}
                        onClick={() => void run(current().games.length)}
                      >
                        Show more games
                      </button>
                    </div>
                  </Show>
                </div>
              </>
            )}
          </Match>
          <Match when={!page()}>
            <EmptyState class="m-2 flex-1">Mochi is fetching the games…</EmptyState>
          </Match>
        </Switch>
      </Card>
    </div>
  );
}

function GameRowView(props: { game: GameSummary; onOpen: () => void; onDelete: () => void }) {
  const cell = "py-1.5 group-hover:bg-blush-100/60";
  const opening = () =>
    [props.game.eco, props.game.opening].filter(Boolean).join(" ") || props.game.event;
  return (
    <tr class="group cursor-pointer" onClick={() => props.onOpen()}>
      <td class={`${cell} truncate rounded-l-xl pl-2.5`}>
        <PlayerCell name={props.game.white} elo={props.game.whiteElo} />
      </td>
      <td class={`${cell} truncate`}>
        <PlayerCell name={props.game.black} elo={props.game.blackElo} />
      </td>
      <td class={`${cell} font-mono text-[12px] font-bold`}>{formatResult(props.game.result)}</td>
      <td class={`${cell} font-mono text-[12px] text-ink/80`}>{formatDate(props.game.date)}</td>
      <td class={`${cell} truncate`} title={[opening(), props.game.event].join(" · ")}>
        <span class="font-semibold">{opening()}</span>
        <Show when={props.game.event && opening() !== props.game.event}>
          <span class="text-muted"> · {props.game.event}</span>
        </Show>
      </td>
      <td class={`${cell} text-right font-mono text-[12px] text-ink/80`}>
        <Show when={props.game.ply !== null} fallback={Math.ceil(props.game.plies / 2)}>
          <span title="Opens at the searched position">
            {Math.floor((props.game.ply ?? 0) / 2) + 1}/{Math.ceil(props.game.plies / 2)}
          </span>
        </Show>
      </td>
      <td class={`${cell} rounded-r-xl pr-1 text-right`}>
        <button
          type="button"
          aria-label={`Delete ${props.game.white || "?"} vs ${props.game.black || "?"}`}
          title="Delete from the database"
          onClick={(event) => {
            event.stopPropagation();
            props.onDelete();
          }}
          class="grid size-7 place-items-center rounded-lg text-ink/50 opacity-0 group-hover:opacity-100 hover:bg-blush-200 hover:text-ink focus-visible:opacity-100"
        >
          <TrashIcon class="size-4" />
        </button>
      </td>
    </tr>
  );
}

function PlayerCell(props: { name: string; elo: number | null }) {
  return (
    <>
      <span class="font-bold">{props.name || "?"}</span>
      <Show when={props.elo}>
        <span class="text-ink/60"> {props.elo}</span>
      </Show>
    </>
  );
}

/** `2026.01.02` as `2026-01-02`, keeping unknown parts out: `2026.??.??` becomes `2026`. */
function formatDate(date: string): string {
  const parts = date.split(".").filter((part) => /^\d+$/.test(part));
  return parts.join("-") || "—";
}
