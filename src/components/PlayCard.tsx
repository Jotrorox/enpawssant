import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import type { Color } from "../chess/board";
import { describeOutcome, type Outcome } from "../chess/outcome";
import { formatClock, timeControlLabel } from "../game/clock";
import type { EngineGame } from "../game/play";
import type { GameSession } from "../game/session";
import { ChessClockIcon } from "./Icons";
import { Card, CardTitle } from "./ui";

/** Time left below which a clock turns red, in ms. */
const LOW_TIME_MS = 20_000;
/** How long the resign button waits for its confirming second click, in ms. */
const CONFIRM_MS = 3000;

const SMALL_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-xl px-3 text-[13px] font-bold whitespace-nowrap transition-colors";
const PRIMARY = `${SMALL_BUTTON} bg-blush-400 text-ink shadow-[inset_0_-2px_0_rgb(224_112_143/0.6)] hover:bg-blush-300`;
const SECONDARY = `${SMALL_BUTTON} bg-blush-100 text-ink hover:bg-blush-200`;
const DANGER = `${SMALL_BUTTON} bg-rose text-white hover:bg-rose-strong`;

/** The clocks, players and controls of a game against the engine. */
export function PlayCard(props: { session: GameSession; game: EngineGame; onNewGame: () => void }) {
  const game = () => props.game;
  const you = () => game().settings.color;
  const engineSide = (): Color => (you() === "w" ? "b" : "w");
  const nameOf = (side: Color) => {
    const info = props.session.info();
    return side === "w" ? info.white.name : info.black.name;
  };
  const watchingEnd = () => props.session.currentId() === game().endId();

  const [confirming, setConfirming] = createSignal(false);
  let confirmTimer: number | undefined;
  onCleanup(() => clearTimeout(confirmTimer));
  const resign = () => {
    if (confirming()) {
      clearTimeout(confirmTimer);
      setConfirming(false);
      game().resign();
      return;
    }
    setConfirming(true);
    confirmTimer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
  };

  return (
    <Card class="shrink-0 px-[18px] pt-3 pb-3.5">
      <div class="mb-2 flex items-center gap-2.5">
        <CardTitle>Game vs Stockfish</CardTitle>
        <span class="rounded-full bg-blush-100 px-2.5 py-px font-mono text-[12px] font-bold">
          {timeControlLabel(game().settings.timeControl)}
        </span>
        <div class="ml-auto flex items-center gap-2">
          <Show
            when={game().playing()}
            fallback={
              <button type="button" class={PRIMARY} onClick={() => props.onNewGame()}>
                <ChessClockIcon class="size-4" />
                New game
              </button>
            }
          >
            <button type="button" class={confirming() ? DANGER : SECONDARY} onClick={resign}>
              {confirming() ? "Really resign?" : "Resign"}
            </button>
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <PlayerRow
          side={engineSide()}
          name={nameOf(engineSide())}
          game={game()}
          note={game().thinking() ? "thinking…" : undefined}
        />
        <PlayerRow side={you()} name={nameOf(you())} game={game()} />
      </div>

      <p class="mt-2.5 flex min-h-[32px] items-center gap-2 text-[13px]" aria-live="polite">
        <Switch>
          <Match when={game().outcome()}>
            {(outcome) => (
              <span class="font-semibold">
                {describeOutcome(outcome())} {verdict(outcome(), you())}
              </span>
            )}
          </Match>
          <Match when={game().error()}>
            {(error) => (
              <>
                <span class="min-w-0 flex-1 text-error">
                  Stockfish got tangled in the yarn: {error()}. The clock is paused.
                </span>
                <button type="button" class={SECONDARY} onClick={() => game().retry()}>
                  Try again
                </button>
              </>
            )}
          </Match>
          <Match when={!watchingEnd()}>
            <span class="min-w-0 flex-1 text-muted">You're looking back at an earlier move.</span>
            <button
              type="button"
              class={SECONDARY}
              onClick={() => props.session.goTo(game().endId())}
            >
              Back to the game
            </button>
          </Match>
          <Match when={game().turn() === you()}>
            <span class="font-semibold">Your move.</span>
          </Match>
          <Match when={true}>
            <span class="text-muted">Stockfish is thinking…</span>
          </Match>
        </Switch>
      </p>
    </Card>
  );
}

function PlayerRow(props: { side: Color; name: string; game: EngineGame; note?: string }) {
  const time = () => props.game.timeLeft(props.side);
  const running = () => props.game.clockRunning() === props.side;
  const toMove = () => props.game.playing() && props.game.turn() === props.side;
  const low = () => (time() ?? Number.POSITIVE_INFINITY) < LOW_TIME_MS;
  const clockColors = () => {
    if (running()) return low() ? "bg-rose text-white" : "bg-plum text-white";
    return `bg-white ring-1 ring-blush-200 ${low() ? "text-rose-strong" : "text-ink"}`;
  };

  return (
    <div
      class={`flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors ${
        toMove() ? "bg-blush-100/80" : ""
      }`}
    >
      <span
        aria-hidden="true"
        class={`size-3 shrink-0 rounded-[3px] ${
          props.side === "w" ? "border-[1.5px] border-plum bg-white" : "bg-plum"
        }`}
      />
      <span class="truncate text-[14px] font-bold">{props.name}</span>
      <Show when={props.note}>
        <span class="shrink-0 text-[12px] text-muted">{props.note}</span>
      </Show>
      <Show when={time() !== undefined}>
        <span
          role="timer"
          aria-label={`${props.side === "w" ? "White" : "Black"} clock`}
          class={`ml-auto shrink-0 rounded-lg px-2.5 py-0.5 font-mono text-[18px] font-semibold tabular-nums transition-colors ${clockColors()}`}
        >
          {formatClock(time() ?? 0)}
        </span>
      </Show>
    </div>
  );
}

/** The result from the user's side of the board. */
function verdict(outcome: Outcome, you: Color): string {
  if (outcome.result === "1/2-1/2") return "Everybody naps.";
  const youWon = (outcome.result === "1-0") === (you === "w");
  return youWon ? "You win, nya!" : "Stockfish takes this one.";
}
