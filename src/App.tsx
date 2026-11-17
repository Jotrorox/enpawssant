import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
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
import { readPgnFile, rememberFile } from "./chess/files";
import type { ImportedGame, ParsedPgn, PgnGame } from "./chess/pgn";
import { mainline } from "./chess/review";
import type { Score } from "./chess/score";
import type { NodeId } from "./chess/tree";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardPanel } from "./components/BoardPanel";
import { type DatabaseRequest, DatabaseView } from "./components/DatabaseView";
import { EnginesView } from "./components/EnginesView";
import { FilesView } from "./components/FilesView";
import { PawIcon } from "./components/Icons";
import { ExportDialog, ImportDialog } from "./components/PgnDialogs";
import { PuzzlesView } from "./components/PuzzlesView";
import { type Section, SideRail } from "./components/SideRail";
import { TitleBar, type WorkspaceTab } from "./components/TitleBar";
import { EmptyState, type Toast, Toasts } from "./components/ui";
import { createGameSession, type GameSession, gameTitle } from "./game/session";
import { loadWorkspace, saveWorkspace } from "./game/workspace";

/** Number of engine lines shown in the analysis panel. */
const ENGINE_LINES = 3;
/** Lines of the engine running alongside the main one. */
const SECOND_ENGINE_LINES = 2;
const TOAST_MS = 5000;
/** Depth every position is searched to by "Analyze full game". */
const REVIEW_DEPTH = 16;

/** A workspace tab and the game open in it. */
type Tab = WorkspaceTab & { session: GameSession };

export default function App() {
  let opened = 0;
  const createTab = (game: PgnGame, title = gameTitle(game), position?: number[]): Tab => {
    opened += 1;
    return { id: `game-${opened}`, title, session: createGameSession(game, { position }) };
  };
  const createBoard = () => createTab({ headers: [], startFen: START_FEN, moves: [] }, "New board");

  // Reopen the tabs from last time, or start on an empty board.
  const saved = loadWorkspace();
  const restored = (saved?.tabs ?? []).flatMap((tab) => {
    try {
      return [createTab(tab.game, tab.title, tab.position)];
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
  const [section, setSection] = createSignal<Section>("board");
  const [databaseRequest, setDatabaseRequest] = createSignal<DatabaseRequest>();
  const [dropping, setDropping] = createSignal(false);
  const [toasts, setToasts] = createSignal<Toast[]>([]);

  onMount(() => void loadEngines());

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
    closing?.session.dispose();
  };

  const openTabs = (created: Tab[]) => {
    setTabs([...tabs(), ...created]);
    setActiveId(created[0]?.id);
    setSection("board");
  };

  const openGames = (games: PgnGame[]) => openTabs(games.map((game) => createTab(game)));

  const newTab = () => openTabs([createBoard()]);

  const selectTab = (id: string) => {
    setActiveId(id);
    setSection("board");
  };

  /** Opens games read from files: one game straight away, several in the game picker. */
  const openFiles = (parsed: ParsedPgn & { name?: string }) => {
    const [only] = parsed.games;
    if (parsed.games.length === 1 && parsed.errors.length === 0 && only.warnings.length === 0) {
      openGames([only]);
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
    const name = fulfilled.length === 1 ? fulfilled[0].name : `${paths.length} files`;
    openFiles({ games, errors, truncated, name });
  };

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
      openTabs([createTab(game, gameTitle(game), ply ? Array<number>(ply).fill(0) : undefined)]);
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
        <SideRail active={section()} onSelect={setSection} />
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
                  openTabs([createTab(game, gameTitle(game), position)])
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
                    onImport={() => {
                      setPreset(undefined);
                      setImporting(true);
                    }}
                    onExport={() => setExporting(true)}
                    onSaveToDatabase={() => void saveToDatabase()}
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
      />
      <ExportDialog
        open={exporting()}
        session={activeTab()?.session}
        onClose={() => setExporting(false)}
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
  onImport: () => void;
  onExport: () => void;
  onSaveToDatabase: () => void;
}) {
  const session = props.session;
  const [orientation, setOrientation] = createSignal<Color>("w");
  const fen = () => session.node().fen;

  const [engineOn, setEngineOn] = createSignal(true);
  const primaryId = () => enginesConfig.primary;
  const secondaryId = () => enginesConfig.secondary ?? undefined;
  const engine = createEngineAnalysis({
    engineId: primaryId,
    fen,
    enabled: engineOn,
    multipv: ENGINE_LINES,
  });
  const second = createEngineAnalysis({
    engineId: secondaryId,
    fen,
    enabled: engineOn,
    multipv: SECOND_ENGINE_LINES,
  });
  const analysis = () => engine.analysisOf(fen());
  /** The engine's evaluation of a node, or else the one the game was imported with. */
  const scoreOf = (id: string) => {
    const node = session.tree.nodes[id];
    return positionScore(engine.analysisOf(node.fen)) ?? node.eval;
  };
  // Positions without either stay empty in the eval graph.
  const evals = createMemo(() => session.line().map(scoreOf));

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

  const arrows = createMemo(() => {
    const current = analysis();
    return engineOn() && current ? lineArrows(current) : [];
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
        orientation={orientation()}
        onFlip={() => setOrientation((side) => (side === "w" ? "b" : "w"))}
        onPly={session.goToIndex}
        onMove={session.play}
        onImport={props.onImport}
        onExport={props.onExport}
        onSaveToDatabase={props.onSaveToDatabase}
        review={engine.reviewProgress()}
        reviewError={engine.reviewError()}
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
        score={scoreOf(session.currentId())}
        engineOn={engineOn()}
        onToggleEngine={() => setEngineOn((on) => !on)}
      />
    </div>
  );
}
