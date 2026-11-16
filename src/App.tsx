import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { Color } from "./chess/board";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BoardPanel } from "./components/BoardPanel";
import { SideRail } from "./components/SideRail";
import { TitleBar, type WorkspaceTab } from "./components/TitleBar";
import { EmptyState } from "./components/ui";
import { analysisByPly, game, type Nag, START_EVAL, START_FEN } from "./data/mockGame";

const GAME_TAB_ID = "game";

export default function App() {
  const [tabs, setTabs] = createSignal<WorkspaceTab[]>([
    { id: GAME_TAB_ID, title: `${game.white.name} vs ${game.black.name}`, live: true },
    { id: "prep", title: "Opening prep · Italian" },
    { id: "puzzle", title: "Purrzle #2451" },
  ]);
  const [activeTab, setActiveTab] = createSignal<string | undefined>(GAME_TAB_ID);
  let untitled = 0;

  const closeTab = (id: string) => {
    const remaining = tabs().filter((tab) => tab.id !== id);
    if (activeTab() === id) {
      const index = tabs().findIndex((tab) => tab.id === id);
      setActiveTab(remaining[Math.min(index, remaining.length - 1)]?.id);
    }
    setTabs(remaining);
  };

  const newTab = () => {
    untitled += 1;
    const tab = { id: `new-${untitled}`, title: "New board" };
    setTabs([...tabs(), tab]);
    setActiveTab(tab.id);
  };

  return (
    <div class="flex h-full flex-col">
      <TitleBar
        tabs={tabs()}
        activeId={activeTab()}
        onSelect={setActiveTab}
        onClose={closeTab}
        onNew={newTab}
      />
      <div class="flex min-h-0 flex-1">
        <SideRail />
        <main class="min-w-0 flex-1">
          <Show
            when={activeTab() === GAME_TAB_ID}
            fallback={
              <div class="grid h-full place-items-center p-8">
                <EmptyState class="w-full max-w-md">
                  <For each={tabs().filter((tab) => tab.id === activeTab())}>
                    {(tab) => <span class="font-bold text-ink">{tab.title}</span>}
                  </For>
                  <span>Nothing here yet. This board is still curled up asleep.</span>
                </EmptyState>
              </div>
            }
          >
            <GameWorkspace />
          </Show>
        </main>
      </div>
    </div>
  );
}

function GameWorkspace() {
  const [moves, setMoves] = createStore(structuredClone(game.moves));
  const maxPly = moves.length;
  const [ply, setPly] = createSignal(maxPly);
  const [orientation, setOrientation] = createSignal<Color>("w");

  const goTo = (target: number) => setPly(Math.max(0, Math.min(maxPly, target)));
  const fen = () => (ply() === 0 ? START_FEN : moves[ply() - 1].fen);
  const lastMove = () => (ply() === 0 ? undefined : moves[ply() - 1]);
  const evals = () => [START_EVAL, ...moves.map((move) => move.eval)];
  const analysis = () => analysisByPly[ply()];

  const toggleNag = (nag: Nag) => {
    if (ply() === 0) return;
    setMoves(ply() - 1, "nag", (current) => (current === nag ? undefined : nag));
  };

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]") || event.metaKey || event.ctrlKey) {
        return;
      }
      const step: Record<string, () => void> = {
        ArrowLeft: () => goTo(ply() - 1),
        ArrowRight: () => goTo(ply() + 1),
        Home: () => goTo(0),
        End: () => goTo(maxPly),
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
        game={game}
        ply={ply()}
        maxPly={maxPly}
        fen={fen()}
        evals={evals()}
        lastMove={lastMove()}
        arrows={analysis()?.arrows}
        orientation={orientation()}
        onFlip={() => setOrientation((side) => (side === "w" ? "b" : "w"))}
        onPly={goTo}
      />
      <AnalysisPanel
        game={game}
        moves={moves}
        ply={ply()}
        fen={fen()}
        analysis={analysis()}
        onPly={goTo}
        onToggleNag={toggleNag}
      />
    </div>
  );
}
