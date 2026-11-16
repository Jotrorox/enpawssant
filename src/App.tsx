import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { type Color, START_FEN } from "./chess/board";
import { createEngineAnalysis, lineArrows, positionScore } from "./chess/engine";
import type { PgnGame } from "./chess/pgn";
import { mainline } from "./chess/review";
import type { Score } from "./chess/score";
import type { NodeId } from "./chess/tree";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardPanel } from "./components/BoardPanel";
import { ExportDialog, ImportDialog } from "./components/PgnDialogs";
import { SideRail } from "./components/SideRail";
import { TitleBar, type WorkspaceTab } from "./components/TitleBar";
import { EmptyState } from "./components/ui";
import { sampleGame } from "./data/mockGame";
import { createGameSession, type GameSession, gameTitle } from "./game/session";

/** Number of engine lines shown in the analysis panel. */
const ENGINE_LINES = 3;
/** Depth every position is searched to by "Analyze full game". */
const REVIEW_DEPTH = 16;

/** A workspace tab. Tabs without a session are placeholders for features still to come. */
type Tab = WorkspaceTab & { session?: GameSession };

export default function App() {
  const [tabs, setTabs] = createSignal<Tab[]>([
    {
      id: "sample",
      title: gameTitle(sampleGame),
      live: true,
      session: createGameSession(sampleGame),
    },
    { id: "prep", title: "Opening prep · Italian" },
    { id: "puzzle", title: "Purrzle #2451" },
  ]);
  const [activeId, setActiveId] = createSignal<string | undefined>("sample");
  const activeTab = () => tabs().find((tab) => tab.id === activeId());
  const [importing, setImporting] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  let opened = 0;

  const closeTab = (id: string) => {
    const index = tabs().findIndex((tab) => tab.id === id);
    const closing = tabs()[index];
    const remaining = tabs().filter((tab) => tab.id !== id);
    if (activeId() === id) setActiveId(remaining[Math.min(index, remaining.length - 1)]?.id);
    setTabs(remaining);
    closing?.session?.dispose();
  };

  const openGames = (games: PgnGame[], title?: string) => {
    const created = games.map((game) => {
      opened += 1;
      return {
        id: `game-${opened}`,
        title: title ?? gameTitle(game),
        session: createGameSession(game),
      };
    });
    setTabs([...tabs(), ...created]);
    setActiveId(created[0]?.id);
  };

  const newTab = () => openGames([{ headers: [], startFen: START_FEN, moves: [] }], "New board");

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
            when={activeTab()?.session}
            keyed
            fallback={
              <div class="grid h-full place-items-center p-8">
                <EmptyState class="w-full max-w-md">
                  <span class="font-bold text-ink">{activeTab()?.title ?? "No tabs open"}</span>
                  <span>Nothing here yet. This board is still curled up asleep.</span>
                </EmptyState>
              </div>
            }
          >
            {(session) => (
              <GameWorkspace
                session={session}
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
        review={engine.reviewProgress()}
        reviewError={engine.reviewError()}
        onReview={() => void reviewGame()}
        onCancelReview={engine.cancelReview}
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
