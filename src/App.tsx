import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { type Color, START_FEN } from "./chess/board";
import { createEngineAnalysis, lineArrows, positionScore } from "./chess/engine";
import type { PgnGame } from "./chess/pgn";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardPanel } from "./components/BoardPanel";
import { ExportDialog, ImportDialog } from "./components/PgnDialogs";
import { SideRail } from "./components/SideRail";
import { TitleBar, type WorkspaceTab } from "./components/TitleBar";
import { EmptyState } from "./components/ui";
import { createGameSession, type GameSession, gameTitle } from "./game/session";
import { loadWorkspace, saveWorkspace } from "./game/workspace";

/** Number of engine lines shown in the analysis panel. */
const ENGINE_LINES = 3;

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
  const [exporting, setExporting] = createSignal(false);

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
  };

  const openGames = (games: PgnGame[]) => openTabs(games.map((game) => createTab(game)));

  const newTab = () => openTabs([createBoard()]);

  return (
    <div class="flex h-full flex-col">
      <TitleBar
        tabs={tabs()}
        activeId={activeId()}
        onSelect={setActiveId}
        onClose={closeTab}
        onNew={newTab}
      />
      <div class="flex min-h-0 flex-1">
        <SideRail />
        <main class="min-w-0 flex-1">
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
                onImport={() => setImporting(true)}
                onExport={() => setExporting(true)}
              />
            )}
          </Show>
        </main>
      </div>
      <ImportDialog
        open={importing()}
        onClose={() => setImporting(false)}
        onOpen={(games) => openGames(games)}
      />
      <ExportDialog
        open={exporting()}
        session={activeTab()?.session}
        onClose={() => setExporting(false)}
      />
    </div>
  );
}

function GameWorkspace(props: {
  session: GameSession;
  onImport: () => void;
  onExport: () => void;
}) {
  const session = props.session;
  const [orientation, setOrientation] = createSignal<Color>("w");
  const fen = () => session.node().fen;

  const [engineOn, setEngineOn] = createSignal(true);
  const engine = createEngineAnalysis({ fen, enabled: engineOn, multipv: ENGINE_LINES });
  const analysis = () => engine.analysisOf(fen());
  /** The engine's evaluation of a node, or else the one the game was imported with. */
  const scoreOf = (id: string) => {
    const node = session.tree.nodes[id];
    return positionScore(engine.analysisOf(node.fen)) ?? node.eval;
  };
  // Positions without either stay empty in the eval graph.
  const evals = createMemo(() => session.line().map(scoreOf));
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
      />
      <AnalysisPanel
        session={session}
        analysis={analysis()}
        score={scoreOf(session.currentId())}
        engineOn={engineOn()}
        engineError={engine.error()}
        onToggleEngine={() => setEngineOn((on) => !on)}
      />
    </div>
  );
}
