import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  type Resource,
  Show,
  Switch,
} from "solid-js";
import { fenPlyIndex, fenTurn, moveNumberPrefix } from "../chess/board";
import { type AnalysisUpdate, type EngineInfo, fetchEngineInfo } from "../chess/engine";
import {
  createExplorer,
  type ExplorerError,
  type ExplorerResult,
  type ExplorerState,
  fetchOpeningName,
  type ResultCounts,
  resultShares,
  totalGames,
} from "../chess/explorer";
import { cancelSignIn, lichessAccount, markSignedOut, signIn, signOut } from "../chess/lichess";
import { parseUciMove } from "../chess/rules";
import { formatScore, type GameResult, type Score, shareFor } from "../chess/score";
import type { EngineGame } from "../game/play";
import type { GameSession } from "../game/session";
import { CatIcon } from "./Icons";
import { Notation } from "./Notation";
import { PlayCard } from "./PlayCard";
import { Card, CardTitle, EmptyState, PRIMARY_BUTTON, SECONDARY_BUTTON, Segmented } from "./ui";

type PanelTab = "analysis" | "database" | "annotate" | "info";

const PANEL_TABS = [
  { value: "analysis", label: "Analysis" },
  { value: "database", label: "Database" },
  { value: "annotate", label: "Annotate" },
  { value: "info", label: "Info" },
] as const;

type AnalysisPanelProps = {
  session: GameSession;
  analysis?: AnalysisUpdate;
  /** Evaluation of the current position: the engine's, or the one the game was imported with. */
  score?: Score;
  engineOn: boolean;
  engineError?: string;
  onToggleEngine: () => void;
  /** The game against the engine in this tab, if there is one. */
  game?: EngineGame;
  onNewGame: () => void;
};

export function AnalysisPanel(props: AnalysisPanelProps) {
  const fen = () => props.session.node().fen;
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
        <Show when={props.game}>
          {(game) => <PlayCard session={props.session} game={game()} onNewGame={props.onNewGame} />}
        </Show>
        {/* No help from the engine or the explorer while the game is on. */}
        <Show when={!props.game?.playing()}>
          <EngineCard
            engine={engine}
            fen={fen()}
            analysis={props.analysis}
            enabled={props.engineOn}
            error={props.engineError}
            onToggle={props.onToggleEngine}
          />
          <ExplorerCard session={props.session} />
        </Show>
        <Notation session={props.session} score={props.score} />
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
  { value: "lichess", label: "Lichess" },
  { value: "mine", label: "My games" },
] as const;

type ExplorerTab = (typeof EXPLORER_SOURCES)[number]["value"];

/** Rows visible before the move list scrolls, so the notation below keeps its room. */
const EXPLORER_MAX_HEIGHT = "max-h-[214px]";

function ExplorerCard(props: { session: GameSession }) {
  const session = props.session;
  const [tab, setTab] = createSignal<ExplorerTab>("masters");
  const account = lichessAccount;
  const explorer = createExplorer({
    fen: () => session.node().fen,
    source: () => (tab() === "lichess" ? "lichess" : "masters"),
    enabled: () => tab() !== "mine" && account().status === "signedIn",
    onSignedOut: markSignedOut,
  });
  const lineFens = () =>
    session
      .line()
      .slice(0, session.index() + 1)
      .map((id) => session.tree.nodes[id].fen);
  const [opening] = createResource(lineFens, fetchOpeningName);
  /** Moves already in the tree from here, highlighted in the list. */
  const knownMoves = createMemo(
    () => new Set(session.node().children.map((id) => session.tree.nodes[id].move?.uci)),
  );
  const play = (uci: string) => session.play(parseUciMove(uci));

  return (
    <Card class="shrink-0 px-[18px] pt-3 pb-3">
      <div class="flex items-center gap-3">
        <CardTitle>Opening explorer</CardTitle>
        <Segmented
          size="sm"
          label="Explorer source"
          options={EXPLORER_SOURCES}
          value={tab()}
          onChange={setTab}
          class="ml-auto border border-blush-200/80 bg-blush-50"
        />
      </div>
      <p class="mt-0.5 mb-1.5 flex h-5 min-w-0 items-center gap-2 text-[13px]" aria-live="polite">
        <Show
          when={opening.latest}
          fallback={<span class="text-muted">{opening.loading ? "" : "No named opening yet"}</span>}
        >
          {(named) => (
            <>
              <span class="font-mono font-bold text-rose-strong">{named().eco}</span>
              <span class="truncate font-semibold" title={named().name}>
                {named().name}
              </span>
            </>
          )}
        </Show>
      </p>

      <Switch>
        <Match when={tab() === "mine"}>
          <EmptyState>
            Your own games will show up here once EnPawssant keeps a game database.
          </EmptyState>
        </Match>
        <Match when={account().status === "loading"}>
          <EmptyState>Checking for your Lichess account…</EmptyState>
        </Match>
        <Match when={account().status === "signingIn"}>
          <EmptyState class="gap-3">
            <span>Approve EnPawssant on lichess.org in your browser, then come back here.</span>
            <button type="button" class={SECONDARY_BUTTON} onClick={cancelSignIn}>
              Cancel
            </button>
          </EmptyState>
        </Match>
        <Match when={account().status === "signedOut"}>
          <SignInPrompt
            error={(() => {
              const state = account();
              return state.status === "signedOut" ? state.error : undefined;
            })()}
          />
        </Match>
        <Match when={explorer.state()}>
          {(state) => (
            <ExplorerResults
              state={state()}
              knownMoves={knownMoves()}
              onPlay={play}
              onRetry={explorer.retry}
            />
          )}
        </Match>
      </Switch>

      <Show when={tab() !== "mine" && signedInAs()}>
        {(username) => (
          <p class="mt-1.5 flex items-center justify-end gap-1.5 text-[12px] text-muted">
            <span class="truncate">Lichess · {username()}</span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              class="font-semibold underline-offset-2 hover:text-ink hover:underline"
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </p>
        )}
      </Show>
    </Card>
  );
}

function signedInAs(): string | undefined {
  const state = lichessAccount();
  return state.status === "signedIn" ? state.account.username : undefined;
}

function SignInPrompt(props: { error?: string }) {
  return (
    <EmptyState class="gap-3">
      <span>
        Lichess only shares its opening explorer with signed-in players. A free account is enough,
        and EnPawssant can only read the explorer, never play or post as you.
      </span>
      <Show when={props.error}>
        {(error) => <span class="text-error">Mochi couldn't sign you in: {error()}.</span>}
      </Show>
      <button type="button" class={PRIMARY_BUTTON} onClick={() => void signIn()}>
        Sign in with Lichess
      </button>
    </EmptyState>
  );
}

type ExplorerResultsProps = {
  state: ExplorerState;
  knownMoves: Set<string | undefined>;
  onPlay: (uci: string) => void;
  onRetry: () => void;
};

function ExplorerResults(props: ExplorerResultsProps) {
  const result = (): ExplorerResult | undefined => {
    const state = props.state;
    if (state.status === "ready") return state.result;
    if (state.status === "loading") return state.previous;
    return undefined;
  };
  const error = () => (props.state.status === "error" ? props.state.error : undefined);

  return (
    <Switch>
      <Match when={error()}>
        {(error) => (
          <EmptyState class="gap-3">
            <span class={error().kind === "failed" ? "text-error" : ""}>
              {explorerErrorMessage(error())}
            </span>
            <Show when={error().kind !== "signedOut"}>
              <button type="button" class={SECONDARY_BUTTON} onClick={() => props.onRetry()}>
                Try again
              </button>
            </Show>
          </EmptyState>
        )}
      </Match>
      <Match when={!result()}>
        <EmptyState>Mochi is fetching the games…</EmptyState>
      </Match>
      <Match when={result()?.moves.length === 0}>
        <EmptyState>No games reached this position yet.</EmptyState>
      </Match>
      <Match when={result()}>
        {(result) => (
          <div
            class={`${EXPLORER_MAX_HEIGHT} overflow-y-auto transition-opacity ${
              props.state.status === "loading" ? "opacity-50" : ""
            }`}
            aria-busy={props.state.status === "loading"}
          >
            <table class="w-full border-separate border-spacing-y-0.5 text-[14px]">
              <thead class="sticky top-0 z-10 bg-white">
                <tr class="text-left text-[11px] font-bold tracking-[0.08em] text-ink/70 uppercase">
                  <th class="w-[64px] py-1 pl-2.5 font-bold">Move</th>
                  <th class="w-[76px] py-1 text-right font-bold">Games</th>
                  <th class="py-1 pl-3 font-bold">White · Draw · Black</th>
                </tr>
              </thead>
              <tbody>
                <For each={result().moves}>
                  {(move) => (
                    <ExplorerRowView
                      label={move.san}
                      counts={move}
                      title={
                        move.averageRating ? `Average rating ${move.averageRating}` : undefined
                      }
                      highlighted={props.knownMoves.has(move.uci)}
                      onClick={() => props.onPlay(move.uci)}
                    />
                  )}
                </For>
                <ExplorerRowView label="Σ" counts={result()} title="All games" muted />
              </tbody>
            </table>
          </div>
        )}
      </Match>
    </Switch>
  );
}

function explorerErrorMessage(error: ExplorerError): string {
  switch (error.kind) {
    case "signedOut":
      return "Lichess signed you out. Sign in again to keep exploring.";
    case "rateLimited":
      return "Lichess asked Mochi to slow down. Give it a minute, then try again.";
    case "failed":
      return `Mochi couldn't reach Lichess: ${error.message}.`;
  }
}

type ExplorerRowProps = {
  label: string;
  counts: ResultCounts;
  title?: string;
  highlighted?: boolean;
  /** The totals row is not clickable. */
  muted?: boolean;
  onClick?: () => void;
};

function ExplorerRowView(props: ExplorerRowProps) {
  const shares = () => resultShares(props.counts);
  const cell = () =>
    `${props.highlighted ? "bg-blush-100/80" : ""} ${props.onClick ? "group-hover:bg-blush-100/60" : ""}`;
  return (
    <tr
      class={`group ${props.onClick ? "cursor-pointer" : ""} ${props.muted ? "text-ink/70" : ""}`}
      title={props.title}
      onClick={() => props.onClick?.()}
    >
      <td class={`rounded-l-xl py-1.5 pl-2.5 font-bold ${cell()}`}>
        <Show when={props.onClick} fallback={props.label}>
          <button type="button" class="rounded-md font-bold" aria-label={`Play ${props.label}`}>
            {props.label}
          </button>
        </Show>
      </td>
      <td class={`py-1.5 text-right font-mono text-[13px] ${cell()}`}>
        {totalGames(props.counts).toLocaleString("en-US")}
      </td>
      <td class={`rounded-r-xl py-1.5 pr-1.5 pl-3 ${cell()}`}>
        <div class="flex h-[22px] overflow-hidden rounded-full bg-white text-[11px] font-bold ring-1 ring-blush-200">
          <ResultSegment percent={shares().white} class="text-ink" />
          <ResultSegment percent={shares().draw} class="bg-plum-soft text-ink" />
          <ResultSegment percent={shares().black} class="bg-plum text-white" />
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
