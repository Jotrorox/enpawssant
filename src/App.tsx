import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  type Setter,
  Show,
  Switch,
} from "solid-js";
import { type Color, START_FEN } from "./chess/board";
import {
  addGame,
  databaseChanged,
  type ImportSummary,
  importFiles,
  importPaths,
  importProgress,
  loadGame,
} from "./chess/database";
import { createEngineAnalysis, lineArrows, positionScore } from "./chess/engine";
import { enginesConfig, loadEngines } from "./chess/engines";
import {
  clearRecentFiles,
  readPgnFile,
  recentFiles,
  rememberFile,
  showRecentInMenu,
} from "./chess/files";
import {
  type ImportedGame,
  openPgnFile,
  type ParsedPgn,
  type PgnGame,
  parsePgn,
  pgnFileName,
  type SavedPgn,
  savePgnFile,
  writePgnFile,
} from "./chess/pgn";
import { mainline } from "./chess/review";
import type { Score } from "./chess/score";
import { checkPosition, looksLikeFen } from "./chess/setup";
import type { NodeId } from "./chess/tree";
import { onCommand, runCommand, startCommands } from "./commands";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardEditor } from "./components/BoardEditor";
import { BoardPanel } from "./components/BoardPanel";
import { type DatabaseRequest, DatabaseView } from "./components/DatabaseView";
import { EnginesView } from "./components/EnginesView";
import { FilesView } from "./components/FilesView";
import { PawIcon } from "./components/Icons";
import { ExportDialog, ImportDialog } from "./components/PgnDialogs";
import { type NewGame, PlayDialog } from "./components/PlayDialog";
import { PuzzlesView } from "./components/PuzzlesView";
import { SettingsDialog } from "./components/SettingsDialog";
import { type Section, SideRail } from "./components/SideRail";
import { TitleBar, type WorkspaceTab } from "./components/TitleBar";
import { EmptyState, type Toast, Toasts } from "./components/ui";
import { createEngineGame, type EngineGame, engineGameHeaders } from "./game/play";
import { createGameSession, type GameSession, gameTitle } from "./game/session";
import { loadWorkspace, saveWorkspace } from "./game/workspace";
import { settings } from "./settings";

/** Lines of the engine running alongside the main one. */
const SECOND_ENGINE_LINES = 2;
const TOAST_MS = 5000;
/** Depth every position is searched to by "Analyze full game". */
const REVIEW_DEPTH = 16;

/** A workspace tab, the game open in it and the game being played against the engine there. */
type Tab = WorkspaceTab & {
  session: GameSession;
  game?: EngineGame;
  /** The side at the bottom of the board. */
  orientation: Accessor<Color>;
  setOrientation: Setter<Color>;
  /** The PGN file the game came from (when it was the only game in it) or was saved to. */
  path: Accessor<string | undefined>;
  setPath: Setter<string | undefined>;
};

type TabOptions = {
  /** Where to start, as an `indexPath`. */
  position?: number[];
  orientation?: Color;
  path?: string;
};

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

export default function App() {
  let opened = 0;
  const createTab = (game: PgnGame, title = gameTitle(game), options: TabOptions = {}): Tab => {
    opened += 1;
    const [orientation, setOrientation] = createSignal<Color>(options.orientation ?? "w");
    const [path, setPath] = createSignal(options.path);
    return {
      id: `game-${opened}`,
      title,
      session: createGameSession(game, { position: options.position }),
      orientation,
      setOrientation,
      path,
      setPath,
    };
  };
  /** A tab for a new game against the engine; it is marked live while the game is on. */
  const createEngineGameTab = ({ settings, startFen, engineName }: NewGame): Tab => {
    const tab = createTab(
      { headers: engineGameHeaders(settings, engineName), startFen, moves: [] },
      undefined,
      { orientation: settings.color },
    );
    const game = createEngineGame(tab.session, settings);
    return {
      ...tab,
      game,
      get live() {
        return game.playing();
      },
    };
  };
  const createBoard = () => createTab({ headers: [], startFen: START_FEN, moves: [] }, "New board");

  // Reopen the tabs from last time, or start on an empty board.
  const saved = loadWorkspace();
  const restored = (saved?.tabs ?? []).flatMap((tab) => {
    try {
      return [
        createTab(tab.game, tab.title, {
          position: tab.position,
          orientation: tab.orientation,
          path: tab.path,
        }),
      ];
    } catch {
      // A game that no longer loads is dropped rather than blocking startup.
      return [];
    }
  });
  const initialTabs = restored.length > 0 ? restored : [createBoard()];
  const initialActive = initialTabs[Math.min(saved?.active ?? 0, initialTabs.length - 1)];

  const [tabs, setTabs] = createSignal<Tab[]>(initialTabs);
  const [activeId, setActiveId] = createSignal<string | undefined>(initialActive.id);
  const activeTab = () => tabs().find((tab) => tab.id === activeId());
  const [importing, setImporting] = createSignal(false);
  /** Games read from dropped files, shown in the import dialog's game picker. */
  const [preset, setPreset] = createSignal<ParsedPgn & { name?: string }>();
  const [exporting, setExporting] = createSignal(false);
  const [choosingGame, setChoosingGame] = createSignal(false);
  const [section, setSection] = createSignal<Section>("board");
  const [databaseRequest, setDatabaseRequest] = createSignal<DatabaseRequest>();
  const [dropping, setDropping] = createSignal(false);
  const [editingPosition, setEditingPosition] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [toasts, setToasts] = createSignal<Toast[]>([]);

  onMount(() => void loadEngines());
  onMount(() => onCleanup(startCommands()));
  createEffect(() => void showRecentInMenu(recentFiles()).catch(() => {}));

  let toastId = 0;
  const notify = (message: string, tone: Toast["tone"] = "info") => {
    const id = ++toastId;
    setToasts((list) => [...list.slice(-3), { id, message, tone }]);
    setTimeout(() => dismiss(id), tone === "error" ? TOAST_MS * 2 : TOAST_MS);
  };
  const dismiss = (id: number) => setToasts((list) => list.filter((toast) => toast.id !== id));

  // Save on every change to the open games, positions or tab selection. A game is small, so
  // writing it all again is cheap and nothing is lost when the window closes.
  createEffect(() => {
    saveWorkspace({
      tabs: tabs().map((tab) => ({
        title: tab.title,
        game: tab.session.toPgn(),
        position: tab.session.position(),
        orientation: tab.orientation(),
        path: tab.path(),
      })),
      active: Math.max(
        0,
        tabs().findIndex((tab) => tab.id === activeId()),
      ),
    });
  });

  const closeTab = (id: string) => {
    const index = tabs().findIndex((tab) => tab.id === id);
    const closing = tabs()[index];
    const remaining = tabs().filter((tab) => tab.id !== id);
    if (activeId() === id) setActiveId(remaining[Math.min(index, remaining.length - 1)]?.id);
    setTabs(remaining);
    closing?.game?.dispose();
    closing?.session.dispose();
  };

  const openTabs = (created: Tab[]) => {
    setTabs([...tabs(), ...created]);
    setActiveId(created[0]?.id);
    setSection("board");
  };

  /** Opens games in new tabs; `path` is the file they came from, when it holds just this game. */
  const openGames = (games: PgnGame[], path?: string) =>
    openTabs(
      games.map((game) =>
        createTab(game, undefined, { path: games.length === 1 ? path : undefined }),
      ),
    );

  /** Swaps a tab for another in the same place. */
  const replaceTab = (old: Tab, next: Tab) => {
    setTabs(tabs().map((tab) => (tab.id === old.id ? next : tab)));
    setActiveId(next.id);
    setSection("board");
    old.game?.dispose();
    old.session.dispose();
  };

  /** A board nobody has touched yet: no moves, tags or notes, not from a file. */
  const isBlank = (tab: Tab) => {
    const root = tab.session.tree.nodes[tab.session.tree.rootId];
    return (
      !tab.game &&
      !tab.path() &&
      tab.session.headers().length === 0 &&
      root.children.length === 0 &&
      !root.comment
    );
  };

  /** Opens a checked position on a new board, in place of the current tab if that is blank. */
  const openPosition = (fen: string, orientation?: Color) => {
    const tab = createTab({ headers: [], startFen: fen, moves: [] }, "Position", { orientation });
    const active = activeTab();
    if (active && isBlank(active)) replaceTab(active, tab);
    else openTabs([tab]);
  };

  const newTab = () => openTabs([createBoard()]);

  const selectTab = (id: string) => {
    setActiveId(id);
    setSection("board");
  };

  /**
   * Opens games read from files: one game straight away, several in the game picker. `path` is
   * the file they came from, when there was just one.
   */
  const openFiles = (parsed: ParsedPgn & { name?: string; path?: string }) => {
    const [only] = parsed.games;
    if (parsed.games.length === 1 && parsed.errors.length === 0 && only.warnings.length === 0) {
      openGames([only], parsed.truncated ? undefined : parsed.path);
    } else if (parsed.games.length === 0) {
      notify(parsed.errors[0] ?? "No games found. Is this a PGN file?", "error");
    } else {
      setPreset(parsed);
      setImporting(true);
    }
  };

  const openPaths = async (paths: string[]) => {
    const results = await Promise.allSettled(paths.map(readPgnFile));
    const games: ImportedGame[] = [];
    const errors: string[] = [];
    let truncated = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        rememberFile(result.value);
        games.push(...result.value.games);
        errors.push(...result.value.errors);
        truncated ||= result.value.truncated;
      } else {
        errors.push(String(result.reason));
      }
    }
    const fulfilled = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const single = fulfilled.length === 1 && paths.length === 1 ? fulfilled[0] : undefined;
    openFiles({
      games,
      errors,
      truncated,
      name: single?.name ?? `${paths.length} files`,
      path: single?.path,
    });
  };

  /** Asks for a PGN file and opens its games. */
  const openFileDialog = async () => {
    try {
      const file = await openPgnFile();
      if (!file) return;
      rememberFile(file);
      openFiles(file);
    } catch (e) {
      notify(`Mochi couldn't open the file: ${errorMessage(e)}`, "error");
    }
  };

  /** Opens pasted text: a FEN on a new board, a PGN like a file. */
  const openText = async (text: string) => {
    try {
      if (looksLikeFen(text)) {
        openPosition(await checkPosition(text));
        return;
      }
      const parsed = await parsePgn(text);
      if (parsed.games.length === 0) notify("There's no FEN or PGN on the clipboard.", "error");
      else openFiles({ ...parsed, name: "Pasted PGN" });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const savedTo = (tab: Tab, saved: SavedPgn, announce: boolean) => {
    tab.setPath(saved.path);
    rememberFile({ ...saved, games: [tab.session.toPgn()] });
    if (announce) notify(`Saved ${saved.name}.`);
  };

  /** Saves the active game to its file, or asks where to save it first. */
  const saveActive = async (askForPath: boolean) => {
    const tab = activeTab();
    if (!tab) return;
    const game = tab.session.toPgn();
    const path = tab.path();
    try {
      if (path && !askForPath) {
        try {
          savedTo(tab, await writePgnFile(game, path), true);
          return;
        } catch (e) {
          // The file is gone or has changed; ask where to save instead of overwriting it.
          tab.setPath(undefined);
          notify(`${errorMessage(e)}, so Mochi asks where to save.`, "error");
        }
      }
      const saved = await savePgnFile(game, pgnFileName(tab.title));
      if (saved) savedTo(tab, saved, true);
    } catch (e) {
      notify(`Mochi couldn't save the game: ${errorMessage(e)}`, "error");
    }
  };

  const copyFen = async () => {
    const fen = activeTab()?.session.node().fen;
    if (!fen) return;
    try {
      await navigator.clipboard.writeText(fen);
      notify("FEN copied.");
    } catch (e) {
      notify(`Couldn't copy the FEN: ${errorMessage(e)}`, "error");
    }
  };

  /** Shows the tab `step` places from the active one, wrapping around. */
  const cycleTab = (step: number) => {
    const list = tabs();
    if (list.length === 0) return;
    const index = list.findIndex((tab) => tab.id === activeId());
    selectTab(list[(index + step + list.length) % list.length].id);
  };

  onCommand((command) => {
    if (command.startsWith("section:")) {
      setSection(command.slice("section:".length) as Section);
      return;
    }
    if (command.startsWith("recent:")) {
      const file = recentFiles()[Number(command.slice("recent:".length))];
      if (file) void openPaths([file.path]);
      return;
    }
    switch (command) {
      case "new-tab":
        newTab();
        break;
      case "open":
        void openFileDialog();
        break;
      case "import":
        setPreset(undefined);
        setImporting(true);
        break;
      case "save":
      case "save-as":
        void saveActive(command === "save-as");
        break;
      case "export":
        if (activeTab()) setExporting(true);
        break;
      case "save-to-database":
        void saveToDatabase();
        break;
      case "close-tab": {
        const id = activeId();
        if (id && section() === "board") closeTab(id);
        break;
      }
      case "copy-fen":
        void copyFen();
        break;
      case "flip":
        activeTab()?.setOrientation((side) => (side === "w" ? "b" : "w"));
        break;
      case "edit-position":
        setEditingPosition(true);
        break;
      case "play":
        setChoosingGame(true);
        break;
      case "settings":
        setSettingsOpen(true);
        break;
      case "prev-tab":
      case "next-tab":
        cycleTab(command === "next-tab" ? 1 : -1);
        break;
      case "recent-clear":
        clearRecentFiles();
        break;
    }
  });

  // A FEN or PGN pasted while no text field has focus opens like a file.
  onMount(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, [contenteditable]") ||
        document.querySelector("dialog[open]")
      ) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain").trim();
      if (!text) return;
      event.preventDefault();
      void openText(text);
    };
    document.addEventListener("paste", onPaste);
    onCleanup(() => document.removeEventListener("paste", onPaste));
  });

  const reportImport = (summary: ImportSummary | null) => {
    if (!summary) return;
    const parts = [
      `${summary.cancelled ? "Stopped after importing" : "Imported"} ${count(summary.imported, "game")}`,
    ];
    if (summary.duplicates > 0) parts.push(`${count(summary.duplicates, "game")} already there`);
    if (summary.failed > 0) parts.push(`${count(summary.failed, "game")} couldn't be read`);
    notify(`${parts.join(", ")}.`, summary.imported === 0 && summary.failed > 0 ? "error" : "info");
  };

  const runImport = async (start: () => Promise<ImportSummary | null>) => {
    if (importProgress()) {
      notify("An import is already running.", "error");
      return;
    }
    try {
      reportImport(await start());
    } catch (e) {
      notify(`The import failed: ${String(e)}`, "error");
    }
  };

  const openFromDatabase = async (id: number, ply: number | null) => {
    try {
      const game = await loadGame(id);
      // Searches by position open the game where it reached the position.
      openTabs([
        createTab(game, gameTitle(game), {
          position: ply ? Array<number>(ply).fill(0) : undefined,
        }),
      ]);
    } catch (e) {
      notify(`Mochi couldn't open the game: ${String(e)}`, "error");
    }
  };

  const saveToDatabase = async () => {
    const session = activeTab()?.session;
    if (!session) return;
    try {
      const added = await addGame(session.toPgn());
      databaseChanged();
      notify(added.duplicate ? "This game is already in the database." : "Saved to the database.");
    } catch (e) {
      notify(`Mochi couldn't save the game: ${String(e)}`, "error");
    }
  };

  // PGN files dropped anywhere: imported in the Database section, opened everywhere else.
  let unlistenDrop: (() => void) | undefined;
  onCleanup(() => unlistenDrop?.());
  onMount(async () => {
    try {
      unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") {
          setDropping(payload.paths.some(isPgnPath));
        } else if (payload.type === "leave") {
          setDropping(false);
        } else if (payload.type === "drop") {
          setDropping(false);
          const pgns = payload.paths.filter(isPgnPath);
          if (pgns.length === 0) {
            if (payload.paths.length > 0) notify("Only PGN files can be dropped here.", "error");
          } else if (section() === "database") {
            void runImport(() => importPaths(pgns));
          } else {
            void openPaths(pgns);
          }
        }
      });
    } catch {
      // Outside Tauri (e.g. in tests) there is nothing to listen to.
    }
  });

  return (
    <div class="flex h-full flex-col">
      <TitleBar
        tabs={tabs()}
        activeId={section() === "board" ? activeId() : undefined}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
        onSearch={(text) => {
          setDatabaseRequest({ text, nonce: Date.now() });
          setSection("database");
        }}
      />
      <div class="flex min-h-0 flex-1">
        <SideRail
          active={section()}
          onSelect={setSection}
          onSettings={() => setSettingsOpen(true)}
        />
        <main class="min-w-0 flex-1">
          <Switch>
            <Match when={section() === "files"}>
              <FilesView
                onOpenGames={openGames}
                onImport={(paths) => void runImport(() => importPaths(paths))}
                importing={!!importProgress()}
              />
            </Match>
            <Match when={section() === "database"}>
              <DatabaseView
                request={databaseRequest()}
                currentFen={activeTab()?.session.node().fen}
                canAddCurrent={!!activeTab()}
                onAddCurrent={() => void saveToDatabase()}
                onImportFiles={() => void runImport(importFiles)}
                onOpenGame={(id, ply) => void openFromDatabase(id, ply)}
                notify={notify}
              />
            </Match>
            <Match when={section() === "engines"}>
              <EnginesView />
            </Match>
            <Match when={section() === "puzzles"}>
              <PuzzlesView
                onAnalyze={(game, position) =>
                  openTabs([createTab(game, gameTitle(game), { position })])
                }
                notify={notify}
              />
            </Match>
            <Match when={section() === "board"}>
              <Show
                when={activeTab()}
                keyed
                fallback={
                  <div class="grid h-full place-items-center p-8">
                    <EmptyState class="w-full max-w-md gap-1">
                      <span class="font-bold text-ink">No tabs open</span>
                      <span>The board is curled up asleep.</span>
                      <button
                        type="button"
                        onClick={newTab}
                        class="mt-2 h-9 rounded-xl bg-blush-100 px-4 text-[14px] font-bold text-ink transition-colors hover:bg-blush-200"
                      >
                        Open a new board
                      </button>
                    </EmptyState>
                  </div>
                }
              >
                {(tab) => (
                  <GameWorkspace
                    session={tab.session}
                    game={tab.game}
                    orientation={tab.orientation()}
                    onFlip={() => runCommand("flip")}
                    onEditPosition={() => runCommand("edit-position")}
                    onImport={() => {
                      setPreset(undefined);
                      setImporting(true);
                    }}
                    onExport={() => setExporting(true)}
                    onSaveToDatabase={() => void saveToDatabase()}
                    onPlay={() => setChoosingGame(true)}
                  />
                )}
              </Show>
            </Match>
          </Switch>
        </main>
      </div>
      <ImportDialog
        open={importing()}
        preset={preset()}
        onClose={() => setImporting(false)}
        onOpen={(games) => openGames(games)}
        onOpenPosition={(fen) => openPosition(fen)}
      />
      <ExportDialog
        open={exporting()}
        session={activeTab()?.session}
        title={activeTab()?.title}
        onClose={() => setExporting(false)}
        onSaved={(saved) => {
          const tab = activeTab();
          if (tab) savedTo(tab, saved, false);
        }}
      />
      <BoardEditor
        open={editingPosition()}
        fen={activeTab()?.session.node().fen ?? START_FEN}
        orientation={activeTab()?.orientation() ?? "w"}
        onClose={() => setEditingPosition(false)}
        onApply={openPosition}
      />
      <SettingsDialog open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <PlayDialog
        open={choosingGame()}
        currentFen={activeTab()?.session.node().fen}
        onClose={() => setChoosingGame(false)}
        onStart={(game) => openTabs([createEngineGameTab(game)])}
      />
      <Show when={dropping()}>
        <div class="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-[28px] border-[3px] border-dashed border-rose bg-blush-50/85 backdrop-blur-[2px]">
          <div class="flex flex-col items-center gap-2 text-center">
            <PawIcon class="size-10 text-rose" />
            <p class="font-display text-[20px] font-semibold">
              {section() === "database" ? "Drop to add to your database" : "Drop to open"}
            </p>
            <p class="text-[13px] text-muted">PGN files only, as many as you like.</p>
          </div>
        </div>
      </Show>
      <Toasts toasts={toasts()} onDismiss={dismiss} />
    </div>
  );
}

const isPgnPath = (path: string) => path.toLowerCase().endsWith(".pgn");

/** `1 game`, `1,204 games`. */
function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? noun : `${noun}s`}`;
}

function GameWorkspace(props: {
  session: GameSession;
  game?: EngineGame;
  orientation: Color;
  onFlip: () => void;
  onEditPosition: () => void;
  onImport: () => void;
  onExport: () => void;
  onSaveToDatabase: () => void;
  onPlay: () => void;
}) {
  const session = props.session;
  const game = props.game;
  const fen = () => session.node().fen;
  /** The engine keeps its opinions to itself while a game against it is on. */
  const playing = () => game?.playing() ?? false;

  const [engineOn, setEngineOn] = createSignal(true);
  const primaryId = () => enginesConfig.primary;
  const secondaryId = () => enginesConfig.secondary ?? undefined;
  const engine = createEngineAnalysis({
    engineId: primaryId,
    fen,
    enabled: () => engineOn() && !playing(),
    multipv: () => settings.multipv,
  });
  const second = createEngineAnalysis({
    engineId: secondaryId,
    fen,
    enabled: () => engineOn() && !playing(),
    multipv: () => Math.min(SECOND_ENGINE_LINES, settings.multipv),
  });
  /** What the engine found here, cut to the number of lines asked for in the settings. */
  const analysis = () => {
    const found = engine.analysisOf(fen());
    return found && found.lines.length > settings.multipv
      ? { ...found, lines: found.lines.slice(0, settings.multipv) }
      : found;
  };
  /** The engine's evaluation of a node, or else the one the game was imported with. */
  const scoreOf = (id: string) => {
    const node = session.tree.nodes[id];
    return positionScore(engine.analysisOf(node.fen)) ?? node.eval;
  };
  // Positions without either stay empty in the eval graph.
  const evals = createMemo(() => session.line().map((id) => (playing() ? undefined : scoreOf(id))));

  /** Searches every main-line position to a fixed depth, then stores and judges the results. */
  const reviewGame = async () => {
    const ids = mainline(session.tree);
    const scores = await engine.review(
      ids.map((id) => session.tree.nodes[id].fen),
      REVIEW_DEPTH,
    );
    if (!scores) return;
    const byNode = new Map<NodeId, Score>();
    ids.forEach((id, index) => {
      const score = scores[index];
      if (score) byNode.set(id, score);
    });
    session.review(byNode);
  };

  onCommand((command) => {
    if (command === "toggle-engine") setEngineOn((on) => !on);
    else if (command === "analyze-game" && !playing() && !engine.reviewProgress()) {
      void reviewGame();
    }
  });

  const arrows = createMemo(() => {
    const current = analysis();
    return engineOn() && !playing() && current ? lineArrows(current) : [];
  });

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest("input, textarea, [contenteditable], dialog, [role=menu]") ||
        event.metaKey ||
        event.ctrlKey
      ) {
        return;
      }
      const step: Record<string, () => void> = {
        ArrowLeft: session.prev,
        ArrowRight: session.next,
        ArrowUp: () => session.goToSibling(-1),
        ArrowDown: () => session.goToSibling(1),
        Home: session.first,
        End: session.last,
      };
      const action = step[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <div class="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)] gap-3.5">
      <BoardPanel
        info={session.info()}
        ply={session.index()}
        maxPly={session.line().length - 1}
        fen={fen()}
        evals={evals()}
        lastMove={session.node().move}
        arrows={arrows()}
        shapes={session.shapes()}
        onShapesChange={playing() ? undefined : session.setShapes}
        orientation={props.orientation}
        onFlip={props.onFlip}
        onEditPosition={props.onEditPosition}
        onPly={session.goToIndex}
        onMove={game ? (game.canMove() ? game.move : undefined) : session.play}
        onImport={props.onImport}
        onExport={props.onExport}
        onSaveToDatabase={props.onSaveToDatabase}
        onPlay={props.onPlay}
        review={engine.reviewProgress()}
        reviewError={engine.reviewError()}
        reviewDisabled={playing()}
        onReview={() => void reviewGame()}
        onCancelReview={engine.cancelReview}
      />
      <AnalysisPanel
        session={session}
        primary={{ id: primaryId(), analysis: analysis(), error: engine.error() }}
        secondary={
          secondaryId()
            ? { id: secondaryId() ?? "", analysis: second.analysisOf(fen()), error: second.error() }
            : undefined
        }
        score={playing() ? undefined : scoreOf(session.currentId())}
        engineOn={engineOn()}
        onToggleEngine={() => setEngineOn((on) => !on)}
        game={game}
        onNewGame={props.onPlay}
      />
    </div>
  );
}
