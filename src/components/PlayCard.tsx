import {
  createEffect,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import type { Color } from "../chess/board";
import { openLichessPage, SPEED_NAMES, timeControlName } from "../chess/lichessPlay";
import { describeOutcome, type Outcome } from "../chess/outcome";
import { formatClock, timeControlLabel } from "../game/clock";
import type { OnlineGame } from "../game/online";
import type { EngineGame } from "../game/play";
import { otherSide } from "../game/played";
import type { GameSession } from "../game/session";
import { ChartIcon, ChessClockIcon, ExternalIcon } from "./Icons";
import { Card, CardTitle } from "./ui";

/** Time left below which a clock turns red, in ms. */
const LOW_TIME_MS = 20_000;
/** How long the resign button waits for its confirming second click, in ms. */
const CONFIRM_MS = 3000;

const SMALL_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-xl px-3 text-[13px] font-bold whitespace-nowrap transition-colors disabled:opacity-50";
const PRIMARY = `${SMALL_BUTTON} bg-blush-400 text-ink shadow-[inset_0_-2px_0_rgb(224_112_143/0.6)] hover:bg-blush-300`;
const SECONDARY = `${SMALL_BUTTON} bg-blush-100 text-ink hover:bg-blush-200`;
const DANGER = `${SMALL_BUTTON} bg-rose text-snow hover:bg-rose-strong`;

type AnyGame = EngineGame | OnlineGame;

/** The clocks, players and controls of a game being played: against Stockfish or on Lichess. */
export function PlayCard(props: {
  session: GameSession;
  game: AnyGame;
  onNewGame: () => void;
  /** Opens the finished game in a new tab, with the engine. */
  onAnalyse: () => void;
}) {
  const game = () => props.game;
  const online = () => (props.game.kind === "online" ? props.game : undefined);
  const engine = () => (props.game.kind === "engine" ? props.game : undefined);
  const you = () => game().color();
  const opponentSide = (): Color => otherSide(you());
  const nameOf = (side: Color) => {
    const info = props.session.info();
    return side === "w" ? info.white : info.black;
  };
  const opponentName = () => {
    const current = game();
    return current.kind === "online" ? current.opponentName() : "Stockfish";
  };
  const watchingEnd = () => props.session.currentId() === game().endId();

  // Resigning (and aborting) takes a second click within a few seconds.
  const [confirming, setConfirming] = createSignal(false);
  let confirmTimer: number | undefined;
  onCleanup(() => clearTimeout(confirmTimer));
  const resign = () => {
    if (confirming()) {
      clearTimeout(confirmTimer);
      setConfirming(false);
      const current = game();
      if (current.kind === "online" && current.canAbort()) current.abort();
      else current.resign();
      return;
    }
    setConfirming(true);
    confirmTimer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
  };
  const resignLabel = () => {
    const aborting = online()?.canAbort();
    if (confirming()) return aborting ? "Really abort?" : "Really resign?";
    return aborting ? "Abort" : "Resign";
  };

  return (
    <Card class="shrink-0 px-[18px] pt-3 pb-3.5">
      <div class="mb-2 flex items-center gap-2.5">
        <CardTitle>Game vs {opponentName()}</CardTitle>
        <span class="shrink-0 rounded-full bg-blush-100 px-2.5 py-px font-mono text-[12px] font-bold">
          {timeLabel(game())}
        </span>
        <Show when={online()}>
          {(current) => (
            <button
              type="button"
              title="Open on lichess.org"
              aria-label="Open on lichess.org"
              class="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-blush-100 hover:text-ink"
              onClick={() =>
                void openLichessPage(`https://lichess.org/${current().gameId}`).catch(() => {})
              }
            >
              <ExternalIcon class="size-3.5" />
            </button>
          )}
        </Show>
        <div class="ml-auto flex items-center gap-2">
          <Show
            when={game().playing()}
            fallback={
              <>
                <Show when={game().kind === "engine"}>
                  <button type="button" class={SECONDARY} onClick={() => props.onNewGame()}>
                    <ChessClockIcon class="size-4" />
                    New game
                  </button>
                </Show>
                <button type="button" class={PRIMARY} onClick={() => props.onAnalyse()}>
                  <ChartIcon class="size-4" />
                  Analyse this game
                </button>
              </>
            }
          >
            <Show when={online()}>{(current) => <OfferButtons game={current()} />}</Show>
            <button
              type="button"
              class={confirming() ? DANGER : SECONDARY}
              disabled={online()?.connection() === "connecting"}
              onClick={resign}
            >
              {resignLabel()}
            </button>
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <PlayerRow
          side={opponentSide()}
          name={nameOf(opponentSide()).name}
          rating={nameOf(opponentSide()).rating}
          game={game()}
          note={engine()?.thinking() ? "thinking…" : undefined}
        />
        <PlayerRow
          side={you()}
          name={nameOf(you()).name}
          rating={nameOf(you()).rating}
          game={game()}
        />
      </div>

      <Show when={online()}>{(current) => <OnlineNotices game={current()} />}</Show>

      <p class="mt-2.5 flex min-h-[32px] items-center gap-2 text-[13px]" aria-live="polite">
        <Switch>
          <Match when={game().outcome()}>
            {(outcome) => (
              <span class="font-semibold">
                {describeOutcome(outcome())} {verdict(outcome(), you(), opponentName())}
              </span>
            )}
          </Match>
          <Match when={engine()?.error()}>
            {(error) => (
              <>
                <span class="min-w-0 flex-1 text-error">
                  Stockfish got tangled in the yarn: {error()}. The clock is paused.
                </span>
                <button type="button" class={SECONDARY} onClick={() => engine()?.retry()}>
                  Try again
                </button>
              </>
            )}
          </Match>
          <Match when={online()?.connection() === "connecting"}>
            <span class="text-muted">Connecting to lichess.org…</span>
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
          <Match when={online()?.confirming()}>
            <span class="text-muted">Sending your move…</span>
          </Match>
          <Match when={game().turn() === you()}>
            <span class="font-semibold">Your move.</span>
            <Show when={online()?.firstMoveSeconds()}>
              {(seconds) => (
                <span class="text-muted">
                  Move within {Math.ceil(seconds())} s or the game is aborted.
                </span>
              )}
            </Show>
          </Match>
          <Match when={true}>
            <span class="text-muted">
              {game().kind === "engine"
                ? "Stockfish is thinking…"
                : `Waiting for ${opponentName()}…`}
            </span>
          </Match>
        </Switch>
      </p>

      <Show when={online()?.isAi() === false ? online() : undefined}>
        {(current) => <Chat game={current()} />}
      </Show>
    </Card>
  );
}

function timeLabel(game: AnyGame): string {
  if (game.kind === "engine") return timeControlLabel(game.settings.timeControl);
  const full = game.full();
  if (!full) return "…";
  const control = full.clock
    ? timeControlName({
        type: "clock",
        limitSeconds: full.clock.initial / 1000,
        incrementSeconds: full.clock.increment / 1000,
      })
    : full.daysPerTurn
      ? timeControlName({ type: "correspondence", days: full.daysPerTurn })
      : "Unlimited";
  const speed = full.speed === "correspondence" || !full.clock ? "" : ` ${SPEED_NAMES[full.speed]}`;
  return `${control}${speed}${full.rated ? " · rated" : ""}`;
}

/** Draw and takeback offers, for games on Lichess. */
function OfferButtons(props: { game: OnlineGame }) {
  const game = props.game;
  const busy = () => game.sending() !== undefined;
  return (
    <>
      <Show when={!game.isAi()}>
        <button
          type="button"
          class={SECONDARY}
          disabled={busy() || game.yourOffers().draw || game.theirOffers().draw}
          onClick={() => game.offerDraw()}
        >
          {game.yourOffers().draw ? "Draw offered" : "Offer draw"}
        </button>
      </Show>
      <button
        type="button"
        class={SECONDARY}
        title="Ask to take back your last move"
        disabled={busy() || game.yourOffers().takeback || game.theirOffers().takeback}
        onClick={() => game.proposeTakeback()}
      >
        {game.yourOffers().takeback ? "Takeback asked" : "Takeback"}
      </button>
    </>
  );
}

/** Offers to answer, the opponent leaving, connection trouble and failed actions. */
function OnlineNotices(props: { game: OnlineGame }) {
  const game = props.game;
  const name = () => game.opponentName();
  const busy = () => game.sending() !== undefined;
  return (
    <div class="mt-2 flex flex-col gap-1.5 empty:hidden">
      <Show when={game.playing() && game.theirOffers().draw}>
        <Notice>
          <span class="min-w-0 flex-1">{name()} offers a draw.</span>
          <button type="button" class={PRIMARY} disabled={busy()} onClick={game.acceptDraw}>
            Accept
          </button>
          <button type="button" class={SECONDARY} disabled={busy()} onClick={game.declineDraw}>
            Decline
          </button>
        </Notice>
      </Show>
      <Show when={game.playing() && game.theirOffers().takeback}>
        <Notice>
          <span class="min-w-0 flex-1">{name()} asks to take back a move.</span>
          <button type="button" class={PRIMARY} disabled={busy()} onClick={game.acceptTakeback}>
            Accept
          </button>
          <button type="button" class={SECONDARY} disabled={busy()} onClick={game.declineTakeback}>
            Decline
          </button>
        </Notice>
      </Show>
      <Show when={game.playing() ? game.opponentGone() : undefined}>
        {(gone) => (
          <Notice>
            <Show
              when={gone().claimIn === 0}
              fallback={
                <span class="min-w-0 flex-1">
                  {name()} left the game.
                  <Show when={gone().claimIn}>
                    {(seconds) => <> You can claim it in {Math.ceil(seconds())} s.</>}
                  </Show>
                </span>
              }
            >
              <span class="min-w-0 flex-1">{name()} left the game.</span>
              <button type="button" class={PRIMARY} disabled={busy()} onClick={game.claimVictory}>
                Claim victory
              </button>
              <button type="button" class={SECONDARY} disabled={busy()} onClick={game.claimDraw}>
                Call it a draw
              </button>
            </Show>
          </Notice>
        )}
      </Show>
      <Show when={game.connection() === "reconnecting"}>
        <Notice tone="muted">
          <span>Lost the connection to lichess.org. Reconnecting…</span>
        </Notice>
      </Show>
      <Show when={game.error()}>
        {(error) => (
          <Notice tone="error">
            <span class="min-w-0 flex-1">{error()}</span>
            <button type="button" class={SECONDARY} onClick={game.dismissError}>
              OK
            </button>
          </Notice>
        )}
      </Show>
    </div>
  );
}

function Notice(props: { tone?: "muted" | "error"; children: JSX.Element }) {
  const tone = () =>
    props.tone === "error"
      ? "bg-error/10 text-error"
      : props.tone === "muted"
        ? "bg-blush-50 text-muted"
        : "bg-lavender text-ink";
  return (
    <div class={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-[13px] ${tone()}`}>
      {props.children}
    </div>
  );
}

/** The players' chat, for games against people. */
function Chat(props: { game: OnlineGame }) {
  const game = props.game;
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  let list: HTMLOListElement | undefined;
  // Keep the newest message in view.
  createEffect(() => {
    game.chat();
    if (list) list.scrollTop = list.scrollHeight;
  });
  const send = async (event: SubmitEvent) => {
    event.preventDefault();
    const message = text().trim();
    if (!message || sending()) return;
    setSending(true);
    if (await game.say(message)) setText("");
    setSending(false);
  };
  return (
    <div class="mt-2 border-t border-blush-200 pt-2">
      <ol
        ref={list}
        aria-label="Chat"
        class="flex max-h-[96px] flex-col gap-0.5 overflow-y-auto text-[13px] empty:hidden"
      >
        <For each={game.chat()}>
          {(line) => (
            <li class="break-words">
              <span class="font-bold">{line.user}</span>{" "}
              <span class={line.user === "lichess" ? "text-muted italic" : ""}>{line.text}</span>
            </li>
          )}
        </For>
      </ol>
      <form class="mt-1.5 flex gap-2" onSubmit={(event) => void send(event)}>
        <input
          type="text"
          value={text()}
          maxLength={140}
          onInput={(event) => setText(event.currentTarget.value)}
          placeholder={`Say something to ${game.opponentName()}`}
          aria-label="Chat message"
          class="min-w-0 flex-1 rounded-lg border border-blush-200 bg-white px-2.5 py-1 text-[13px] outline-none focus:border-rose"
        />
        <button type="submit" class={SECONDARY} disabled={sending() || !text().trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function PlayerRow(props: {
  side: Color;
  name: string;
  rating?: string;
  game: AnyGame;
  note?: string;
}) {
  const time = () => props.game.timeLeft(props.side);
  const running = () => props.game.clockRunning() === props.side;
  const toMove = () => props.game.playing() && props.game.turn() === props.side;
  const low = () => (time() ?? Number.POSITIVE_INFINITY) < LOW_TIME_MS;
  const clockColors = () => {
    if (running()) return low() ? "bg-rose text-snow" : "bg-plum text-snow";
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
          props.side === "w"
            ? "border-[1.5px] border-plum bg-snow"
            : "bg-plum dark:ring-1 dark:ring-snow/40"
        }`}
      />
      <span class="truncate text-[14px] font-bold">{props.name}</span>
      <Show when={props.rating}>
        <span class="shrink-0 text-[13px] text-ink/75">{props.rating}</span>
      </Show>
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
function verdict(outcome: Outcome, you: Color, opponent: string): string {
  if (outcome.result === "*") return "";
  if (outcome.result === "1/2-1/2") return "Everybody naps.";
  const youWon = (outcome.result === "1-0") === (you === "w");
  return youWon ? "You win, nya!" : `${opponent} takes this one.`;
}
