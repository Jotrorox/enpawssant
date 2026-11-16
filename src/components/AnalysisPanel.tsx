import { createResource, createSignal, For, Match, type Resource, Show, Switch } from "solid-js";
import { fenPlyIndex, fenTurn, moveNumberPrefix } from "../chess/board";
import {
  type AnalysisUpdate,
  type EngineInfo,
  fetchEngineInfo,
  positionScore,
} from "../chess/engine";
import { formatScore, type GameResult, shareFor } from "../chess/score";
import {
  EXPLORER_FEN,
  type ExplorerRow,
  type ExplorerSource,
  explorer,
  type Game,
  type GameMove,
  type Nag,
} from "../data/mockGame";
import { CatIcon } from "./Icons";
import { Notation } from "./Notation";
import { Card, CardTitle, EmptyState, Segmented } from "./ui";

type PanelTab = "analysis" | "database" | "annotate" | "info";

const PANEL_TABS = [
  { value: "analysis", label: "Analysis" },
  { value: "database", label: "Database" },
  { value: "annotate", label: "Annotate" },
  { value: "info", label: "Info" },
] as const;

type AnalysisPanelProps = {
  game: Game;
  moves: GameMove[];
  ply: number;
  fen: string;
  analysis?: AnalysisUpdate;
  engineOn: boolean;
  engineError?: string;
  onToggleEngine: () => void;
  onPly: (ply: number) => void;
  onToggleNag: (nag: Nag) => void;
};

export function AnalysisPanel(props: AnalysisPanelProps) {
  const [tab, setTab] = createSignal<PanelTab>("analysis");
  // Lives here rather than in the engine card so switching panels doesn't restart the engine.
  const [engine] = createResource(fetchEngineInfo);

  return (
    <div class="flex min-h-0 min-w-0 flex-col gap-3 pt-3.5 pr-3.5 pb-3.5">
      <Segmented
        label="Panels"
        options={PANEL_TABS}
        value={tab()}
        onChange={setTab}
        class="shrink-0 border border-blush-200/80 bg-blush-100/80"
      />
      <Show
        when={tab() === "analysis"}
        fallback={
          <Card class="flex flex-1 p-5">
            <EmptyState class="flex-1">
              The {PANEL_TABS.find((t) => t.value === tab())?.label.toLowerCase()} panel is still
              napping. Check back soon!
            </EmptyState>
          </Card>
        }
      >
        <EngineCard
          engine={engine}
          fen={props.fen}
          analysis={props.analysis}
          enabled={props.engineOn}
          error={props.engineError}
          onToggle={props.onToggleEngine}
        />
        <ExplorerCard hasData={props.fen === EXPLORER_FEN} />
        <Notation
          moves={props.moves}
          variations={props.game.variations}
          ply={props.ply}
          fen={props.fen}
          score={positionScore(props.analysis)}
          onPly={props.onPly}
          onToggleNag={props.onToggleNag}
        />
      </Show>
    </div>
  );
}

/** Moves of each engine line to show; the rest would be cut off anyway. */
const LINE_MOVES = 12;

type EngineCardProps = {
  engine: Resource<EngineInfo>;
  fen: string;
  analysis?: AnalysisUpdate;
  enabled: boolean;
  error?: string;
  onToggle: () => void;
};

function EngineCard(props: EngineCardProps) {
  const engine = props.engine;
  const searching = () =>
    props.enabled && props.analysis && !props.analysis.outcome ? props.analysis : undefined;

  return (
    <Card class="shrink-0 px-[18px] pt-3 pb-4">
      <div class="mb-2.5 flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={props.enabled}
          aria-label="Engine analysis"
          onClick={() => props.onToggle()}
          class={`relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors ${
            props.enabled ? "bg-rose" : "bg-plum-soft"
          }`}
        >
          <span
            class={`absolute top-[3px] left-[3px] size-[14px] rounded-full bg-white shadow transition-transform ${
              props.enabled ? "translate-x-[14px]" : ""
            }`}
          />
        </button>

        <div class="flex min-w-0 items-baseline gap-2" aria-live="polite">
          <Switch>
            <Match when={engine.error}>
              <span class="text-[14px] font-bold text-error" title={String(engine.error)}>
                Engine unavailable
              </span>
            </Match>
            <Match when={engine.loading}>
              <span class="text-[14px] font-bold text-muted">Waking up the engine…</span>
            </Match>
            <Match when={engine()}>
              {(info) => (
                <>
                  <span class="text-[15px] font-bold whitespace-nowrap">{info().name}</span>
                  <span class="truncate text-[12px] text-muted">
                    NNUE · {info().threads} {info().threads === 1 ? "thread" : "threads"} ·{" "}
                    {info().hashMb} MB
                  </span>
                </>
              )}
            </Match>
          </Switch>
        </div>

        <Show when={searching()}>
          {(analysis) => (
            <div class="ml-auto flex shrink-0 gap-1.5 font-mono text-[11px] text-ink/80">
              <span class="rounded-md bg-blush-100 px-1.5 py-0.5">
                depth {analysis().depth}/{analysis().seldepth}
              </span>
              <span class="rounded-md bg-blush-100 px-1.5 py-0.5">{formatNps(analysis().nps)}</span>
            </div>
          )}
        </Show>
      </div>

      <Switch>
        <Match when={!props.enabled}>
          <EmptyState>Engine paused. Flip the switch to wake it up.</EmptyState>
        </Match>
        <Match when={props.error}>
          {(error) => (
            <EmptyState class="text-error">
              Mochi got tangled in the yarn: {error()}. Pick a move to try again.
            </EmptyState>
          )}
        </Match>
        <Match when={props.analysis?.outcome}>
          {(outcome) => <EmptyState>{outcomeMessage(outcome())}</EmptyState>}
        </Match>
        <Match when={!props.analysis?.lines.length}>
          <EmptyState>Mochi is sniffing at this position…</EmptyState>
        </Match>
        <Match when={props.analysis}>
          {(analysis) => (
            <>
              <ol class="flex flex-col gap-1">
                <For each={analysis().lines}>
                  {(line, index) => (
                    <li
                      class={`flex items-center gap-3 rounded-xl px-1.5 py-1 ${
                        index() === 0 ? "bg-blush-100/80" : ""
                      }`}
                    >
                      <span class="shrink-0 rounded-lg border border-blush-200 bg-white px-2 py-px font-mono text-[12px]">
                        {formatScore(line.score)}
                      </span>
                      <span class="truncate text-[14px]">
                        <For each={line.san.slice(0, LINE_MOVES)}>
                          {(san, i) => {
                            const prefix = moveNumberPrefix(
                              fenPlyIndex(props.fen) + i(),
                              i() === 0,
                            );
                            return (
                              <span class={i() === 0 ? "font-bold" : ""}>
                                {i() > 0 ? " " : ""}
                                {prefix ? `${prefix} ` : ""}
                                {san}
                              </span>
                            );
                          }}
                        </For>
                      </span>
                    </li>
                  )}
                </For>
              </ol>

              <div class="mt-3 flex items-start gap-3 rounded-2xl bg-lavender px-3.5 py-2.5 text-[13px] leading-snug">
                <span class="grid size-7 shrink-0 place-items-center rounded-full bg-white text-ink">
                  <CatIcon class="size-[18px]" />
                </span>
                <p class="mt-0.5">
                  <span class="font-bold">Coach Mochi:</span> {coachSays(analysis())}
                </p>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </Card>
  );
}

function formatNps(nps: number): string {
  if (nps >= 1e6) return `${(nps / 1e6).toFixed(1)} Mn/s`;
  if (nps >= 1e3) return `${Math.round(nps / 1e3)} kn/s`;
  return `${nps} n/s`;
}

function outcomeMessage(outcome: GameResult): string {
  if (outcome === "1/2-1/2") return "Stalemate! Nobody can move, so everybody naps. ½-½";
  return `Checkmate! ${outcome === "1-0" ? "White" : "Black"} wins. Time for a victory nap.`;
}

/** A one-line take on the best line, from the side to move's point of view. */
function coachSays(analysis: AnalysisUpdate): string {
  const best = analysis.lines[0];
  const move = best.san[0];
  const side = fenTurn(analysis.fen);
  const name = side === "w" ? "White" : "Black";
  const score = best.score;
  if ("mate" in score) {
    const moves = Math.abs(score.mate);
    const winning = score.mate > 0 === (side === "w");
    return winning
      ? `There's a mate in ${moves} for ${name}. Pounce with ${move}!`
      : `Uh oh, ${name} is getting mated in ${moves}. ${move} holds out the longest.`;
  }
  const share = shareFor(score, side);
  if (share > 0.8) return `${name} is winning. ${move} keeps the claws in, nya!`;
  if (share > 0.6) return `${name} is better here. ${move} keeps up the pressure.`;
  if (share >= 0.4) return `Pretty balanced. Mochi would play ${move}.`;
  if (share >= 0.2) return `${name} is a bit worse. ${move} is the toughest defence.`;
  return `${name} is in trouble. ${move} is the best way to scramble.`;
}

const EXPLORER_SOURCES = [
  { value: "masters", label: "Masters" },
  { value: "online", label: "Online" },
  { value: "mine", label: "My games" },
] as const;

function ExplorerCard(props: { hasData: boolean }) {
  const [source, setSource] = createSignal<ExplorerSource>("masters");
  // The placeholder data only covers the final position of the sample game.
  const rows = () => (props.hasData ? explorer[source()] : []);

  return (
    <Card class="shrink-0 px-[18px] pt-3 pb-3">
      <div class="mb-1.5 flex items-center">
        <CardTitle>Opening explorer</CardTitle>
        <Segmented
          size="sm"
          label="Explorer source"
          options={EXPLORER_SOURCES}
          value={source()}
          onChange={setSource}
          class="ml-auto border border-blush-200/80 bg-blush-50"
        />
      </div>

      <Show
        when={rows().length > 0}
        fallback={<EmptyState>No games reached this position yet.</EmptyState>}
      >
        <table class="w-full border-separate border-spacing-y-0.5 text-[14px]">
          <thead>
            <tr class="text-left text-[11px] font-bold tracking-[0.08em] text-ink/70 uppercase">
              <th class="w-[64px] py-1 pl-2.5 font-bold">Move</th>
              <th class="w-[76px] py-1 text-right font-bold">Games</th>
              <th class="py-1 pl-3 font-bold">White · Draw · Black</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(row, index) => <ExplorerRowView row={row} highlighted={index() === 0} />}
            </For>
          </tbody>
        </table>
      </Show>
    </Card>
  );
}

function ExplorerRowView(props: { row: ExplorerRow; highlighted: boolean }) {
  const cell = props.highlighted ? "bg-blush-100/80" : "";
  return (
    <tr class="group">
      <td class={`rounded-l-xl py-1.5 pl-2.5 font-bold group-hover:bg-blush-100/60 ${cell}`}>
        {props.row.move}
      </td>
      <td class={`py-1.5 text-right font-mono text-[13px] group-hover:bg-blush-100/60 ${cell}`}>
        {props.row.games.toLocaleString("en-US")}
      </td>
      <td class={`rounded-r-xl py-1.5 pr-1.5 pl-3 group-hover:bg-blush-100/60 ${cell}`}>
        <div class="flex h-[22px] overflow-hidden rounded-full bg-white text-[11px] font-bold ring-1 ring-blush-200">
          <ResultSegment percent={props.row.white} class="text-ink" />
          <ResultSegment percent={props.row.draw} class="bg-plum-soft text-ink" />
          <ResultSegment percent={props.row.black} class="bg-plum text-white" />
        </div>
      </td>
    </tr>
  );
}

function ResultSegment(props: { percent: number; class: string }) {
  return (
    <div
      class={`grid place-items-center overflow-hidden whitespace-nowrap ${props.class}`}
      style={{ width: `${props.percent}%` }}
    >
      <Show when={props.percent >= 8}>{props.percent}%</Show>
    </div>
  );
}
