import { createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { Color } from "../chess/board";
import { cancelSignIn, lichessAccount, signIn, signOut } from "../chess/lichess";
import {
  type Challenge,
  type ColorChoice,
  challengeAi,
  challengeDirection,
  challengePlayer,
  describeLichessError,
  type GameClock,
  type GameInfo,
  type GameRequest,
  SPEED_NAMES,
  timeControlName,
  toColor,
  toLichessError,
} from "../chess/lichessPlay";
import { formatClock } from "../game/clock";
import { lichessEvents } from "../game/lichessEvents";
import { ChessClockIcon, RetryIcon } from "./Icons";
import {
  Card,
  CardTitle,
  EmptyState,
  INPUT,
  PRIMARY_BUTTON,
  ProgressBar,
  SECONDARY_BUTTON,
  Segmented,
  ViewHeader,
} from "./ui";

/** How often the ongoing games refresh while the section is open, in ms. */
const REFRESH_MS = 30_000;

type Speed = "rapid" | "classical" | "correspondence";

const SPEEDS = [
  { value: "rapid", label: "Rapid" },
  { value: "classical", label: "Classical" },
  { value: "correspondence", label: "Correspondence" },
] as const;

/** The Board API plays people at rapid, classical and correspondence speeds. */
const PRESETS: Record<Speed, { value: string; label: string; clock: GameClock }[]> = {
  rapid: [clockPreset(10, 0), clockPreset(10, 5), clockPreset(15, 10)],
  classical: [clockPreset(30, 0), clockPreset(30, 20), clockPreset(60, 30)],
  correspondence: [1, 3, 7, 14].map((days) => ({
    value: `${days}d`,
    label: days === 1 ? "1 day" : `${days} days`,
    clock: { type: "correspondence", days },
  })),
};

/** Against the AI, blitz and unlimited games are fine too. */
const AI_PRESETS: { value: string; label: string; clock: GameClock }[] = [
  clockPreset(5, 3),
  clockPreset(10, 5),
  clockPreset(15, 10),
  clockPreset(30, 20),
  { value: "unlimited", label: "Unlimited", clock: { type: "unlimited" } },
];

function clockPreset(minutes: number, increment: number) {
  return {
    value: `${minutes}+${increment}`,
    label: `${minutes}+${increment}`,
    clock: { type: "clock", limitSeconds: minutes * 60, incrementSeconds: increment } as GameClock,
  };
}

const COLORS = [
  { value: "white", label: "White" },
  { value: "random", label: "Random" },
  { value: "black", label: "Black" },
] as const;

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8].map((level) => ({
  value: String(level),
  label: String(level),
}));

type Choices = {
  aiLevel: string;
  aiTime: string;
  aiColor: ColorChoice;
  speed: Speed;
  preset: Record<Speed, string>;
  color: ColorChoice;
  rated: boolean;
  opponent: string;
};

const DEFAULTS: Choices = {
  aiLevel: "3",
  aiTime: "10+5",
  aiColor: "random",
  speed: "rapid",
  preset: { rapid: "10+5", classical: "30+20", correspondence: "3d" },
  color: "random",
  rated: false,
  opponent: "",
};

/** The section remembers the last choices; losing them only costs a few clicks. */
const STORAGE_KEY = "enpawssant.lichessPlay";

function loadChoices(): Choices {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const choices: Choices = {
      ...DEFAULTS,
      ...saved,
      preset: { ...DEFAULTS.preset, ...saved.preset },
    };
    const valid =
      LEVELS.some((l) => l.value === choices.aiLevel) &&
      AI_PRESETS.some((p) => p.value === choices.aiTime) &&
      SPEEDS.some((s) => s.value === choices.speed) &&
      SPEEDS.every((s) => PRESETS[s.value].some((p) => p.value === choices.preset[s.value])) &&
      [choices.aiColor, choices.color].every((c) => COLORS.some((o) => o.value === c));
    return valid ? choices : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function saveChoices(choices: Choices) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage may be unavailable; the section then starts from the defaults next time.
  }
}

type PlayViewProps = {
  /** Opens the dialog for a game against Stockfish on this machine. */
  onPlayStockfish: () => void;
  /** Opens a Lichess game in a tab, or switches to its tab. */
  onOpenGame: (game: { id: string; color?: Color }) => void;
  /** Marks a game that is about to start (a challenge's ID), so its tab opens when it does. */
  onExpectGame: (id: string) => void;
  notify: (message: string, tone?: "info" | "error") => void;
};

export function PlayView(props: PlayViewProps) {
  const [choices, setChoices] = createSignal<Choices>(loadChoices());
  const update = (change: Partial<Choices>) => {
    const next = { ...choices(), ...change };
    setChoices(next);
    saveChoices(next);
  };
  const account = lichessAccount;
  const username = () => {
    const state = account();
    return state.status === "signedIn" ? state.account.username : undefined;
  };
  const canPlay = () => {
    const state = account();
    return state.status === "signedIn" && state.account.canPlay;
  };

  const request = (): GameRequest => {
    const picked = choices();
    const preset =
      PRESETS[picked.speed].find((p) => p.value === picked.preset[picked.speed]) ??
      PRESETS[picked.speed][0];
    return { clock: preset.clock, color: picked.color, rated: picked.rated };
  };

  const [startingAi, setStartingAi] = createSignal(false);
  const playAi = async () => {
    const picked = choices();
    const preset = AI_PRESETS.find((p) => p.value === picked.aiTime) ?? AI_PRESETS[0];
    setStartingAi(true);
    try {
      const game = await challengeAi({
        level: Number(picked.aiLevel),
        clock: preset.clock,
        color: picked.aiColor,
      });
      props.onOpenGame(game);
    } catch (reason) {
      props.notify(
        `Mochi couldn't start the game: ${describeLichessError(toLichessError(reason))}`,
        "error",
      );
    } finally {
      setStartingAi(false);
    }
  };

  const seek = async () => {
    const wanted = request();
    const posted = await lichessEvents.seek(wanted);
    if (posted && wanted.clock.type === "correspondence") {
      props.notify("Your seek is up. The game shows under Ongoing games once someone takes it.");
    }
  };

  const [challenging, setChallenging] = createSignal(false);
  const challenge = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = choices().opponent.trim();
    if (!name) return;
    setChallenging(true);
    try {
      const sent = await challengePlayer(name, request());
      props.onExpectGame(sent.id);
      lichessEvents.addChallenge({ ...sent, direction: "out" });
      props.notify(`Challenge sent to ${sent.destUser?.name ?? name}.`);
    } catch (reason) {
      props.notify(
        `Mochi couldn't send the challenge: ${describeLichessError(toLichessError(reason))}`,
        "error",
      );
    } finally {
      setChallenging(false);
    }
  };

  // Turns and time left change with every move, so the list refreshes while it's on screen.
  onMount(() => {
    void lichessEvents.refreshGames();
    const timer = setInterval(() => void lichessEvents.refreshGames(), REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <div class="flex h-full min-h-0 flex-col gap-3.5 p-3.5 pl-[18px]">
      <ViewHeader
        title="Play"
        subtitle="Stockfish on this machine, or the AI and people on lichess.org."
      />
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3.5 overflow-y-auto">
        <div class="flex min-w-0 flex-col gap-3.5">
          <Card class="flex items-center gap-3 px-[18px] py-3.5">
            <div class="min-w-0 flex-1">
              <CardTitle>Stockfish</CardTitle>
              <p class="text-[13px] text-muted">
                Offline, at any strength, with or without a clock.
              </p>
            </div>
            <button type="button" class={PRIMARY_BUTTON} onClick={() => props.onPlayStockfish()}>
              <ChessClockIcon class="size-[18px]" />
              Play vs Stockfish
            </button>
          </Card>

          <Card class="flex flex-col gap-3 px-[18px] py-3.5">
            <div>
              <CardTitle>Lichess AI</CardTitle>
              <p class="text-[13px] text-muted">
                Stockfish on lichess.org at levels 1 to 8. These games are never rated.
              </p>
            </div>
            <Row label="Level">
              <Segmented
                size="sm"
                label="AI level"
                options={LEVELS}
                value={choices().aiLevel}
                onChange={(aiLevel) => update({ aiLevel })}
              />
            </Row>
            <Row label="Time">
              <Segmented
                size="sm"
                label="Time control against the AI"
                options={AI_PRESETS}
                value={choices().aiTime}
                onChange={(aiTime) => update({ aiTime })}
              />
            </Row>
            <Row label="You play">
              <Segmented
                size="sm"
                label="Your colour against the AI"
                options={COLORS}
                value={choices().aiColor}
                onChange={(aiColor) => update({ aiColor })}
              />
            </Row>
            <div class="flex justify-end">
              <button
                type="button"
                class={PRIMARY_BUTTON}
                disabled={!canPlay() || startingAi()}
                onClick={() => void playAi()}
              >
                <ChessClockIcon class="size-[18px]" />
                {startingAi() ? "Starting…" : "Play vs the AI"}
              </button>
            </div>
          </Card>

          <Card class="flex flex-col gap-3 px-[18px] py-3.5">
            <div>
              <CardTitle>Play a person</CardTitle>
              <p class="text-[13px] text-muted">
                Rapid, classical and correspondence games, the speeds Lichess allows apps to play.
              </p>
            </div>
            <Row label="Speed">
              <Segmented
                size="sm"
                label="Speed"
                options={SPEEDS}
                value={choices().speed}
                onChange={(speed) => update({ speed })}
              />
            </Row>
            <Row label="Time">
              <Segmented
                size="sm"
                label="Time control"
                options={PRESETS[choices().speed]}
                value={choices().preset[choices().speed]}
                onChange={(value) =>
                  update({ preset: { ...choices().preset, [choices().speed]: value } })
                }
              />
            </Row>
            <Row label="You play">
              <Segmented
                size="sm"
                label="Your colour"
                options={COLORS}
                value={choices().color}
                onChange={(color) => update({ color })}
              />
            </Row>
            <Row label="Rated">
              <label class="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={choices().rated}
                  onChange={(event) => update({ rated: event.currentTarget.checked })}
                  class="size-4 accent-rose"
                />
                Rated game
              </label>
            </Row>

            <div class="flex flex-col gap-2 border-t border-blush-200 pt-3">
              <Show
                when={lichessEvents.seeking()}
                fallback={
                  <div class="flex items-center gap-3">
                    <p class="min-w-0 flex-1 text-[13px] text-muted">
                      Seek a game against anyone looking for one.
                    </p>
                    <button
                      type="button"
                      class={PRIMARY_BUTTON}
                      disabled={!canPlay()}
                      onClick={() => void seek()}
                    >
                      Seek a game
                    </button>
                  </div>
                }
              >
                {(seeking) => (
                  <div class="flex items-center gap-3">
                    <div class="min-w-0 flex-1">
                      <p class="text-[13px] font-semibold">
                        Looking for an opponent ({timeControlName(seeking().clock)}
                        {seeking().rated ? ", rated" : ""})…
                      </p>
                      <ProgressBar label="Seeking a game" class="mt-1.5" />
                    </div>
                    <button
                      type="button"
                      class={SECONDARY_BUTTON}
                      onClick={() => lichessEvents.cancelSeek()}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </Show>
              <Show when={lichessEvents.seekError()}>
                {(error) => <p class="text-[13px] text-error">The seek failed: {error()}</p>}
              </Show>
              <form class="flex items-center gap-2" onSubmit={(event) => void challenge(event)}>
                <input
                  type="text"
                  value={choices().opponent}
                  onInput={(event) => update({ opponent: event.currentTarget.value })}
                  placeholder="Lichess username"
                  aria-label="Username to challenge"
                  spellcheck={false}
                  class={`${INPUT} min-w-0 flex-1`}
                />
                <button
                  type="submit"
                  class={SECONDARY_BUTTON}
                  disabled={!canPlay() || challenging() || !choices().opponent.trim()}
                >
                  {challenging() ? "Sending…" : "Challenge"}
                </button>
              </form>
            </div>
          </Card>
        </div>

        <div class="flex min-w-0 flex-col gap-3.5">
          <AccountCard />
          <Show when={canPlay()}>
            <ChallengesCard
              username={username() ?? ""}
              onExpectGame={props.onExpectGame}
              notify={props.notify}
            />
            <OngoingCard onOpenGame={props.onOpenGame} />
          </Show>
        </div>
      </div>
    </div>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex items-center gap-3">
      <span class="w-[68px] shrink-0 text-[11px] font-bold tracking-[0.08em] text-ink/70 uppercase">
        {props.label}
      </span>
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

function AccountCard() {
  const state = lichessAccount;
  return (
    <Card class="flex flex-col gap-2 px-[18px] py-3.5">
      <div class="flex items-center gap-2">
        <CardTitle>Lichess account</CardTitle>
        <Show when={state().status === "signedIn" && lichessEvents.connected()}>
          <span class="flex items-center gap-1.5 text-[12px] text-muted">
            <span class="size-2 rounded-full bg-nag-good" aria-hidden="true" />
            connected
          </span>
        </Show>
      </div>
      <Switch>
        <Match when={state().status === "loading"}>
          <p class="text-[13px] text-muted">Checking the keychain…</p>
        </Match>
        <Match when={state().status === "signingIn"}>
          <div class="flex items-center gap-3">
            <p class="min-w-0 flex-1 text-[13px]">
              Approve EnPawssant on lichess.org in your browser.
            </p>
            <button type="button" class={SECONDARY_BUTTON} onClick={() => cancelSignIn()}>
              Cancel
            </button>
          </div>
        </Match>
        <Match
          when={(() => {
            const current = state();
            return current.status === "signedIn" ? current.account : undefined;
          })()}
        >
          {(account) => (
            <>
              <p class="text-[13px]">
                Signed in as <span class="font-bold">{account().username}</span>.{" "}
                <button
                  type="button"
                  class="font-semibold text-muted underline-offset-2 hover:text-ink hover:underline"
                  onClick={() => void signOut()}
                >
                  Sign out
                </button>
              </p>
              <Show when={!account().canPlay}>
                <div class="flex items-center gap-3 rounded-xl bg-lavender px-3 py-2">
                  <p class="min-w-0 flex-1 text-[13px]">
                    You signed in before EnPawssant could play. Sign in again to allow playing games
                    and handling challenges.
                  </p>
                  <button type="button" class={PRIMARY_BUTTON} onClick={() => void signIn()}>
                    Sign in again
                  </button>
                </div>
              </Show>
            </>
          )}
        </Match>
        <Match when={state().status === "signedOut"}>
          <div class="flex items-center gap-3">
            <p class="min-w-0 flex-1 text-[13px] text-muted">
              Sign in to play the AI and people on lichess.org. A free account is enough.
              <Show when={state().status === "signedOut" && (state() as { error?: string }).error}>
                {(error) => (
                  <span class="block text-error">Mochi couldn't sign you in: {error()}.</span>
                )}
              </Show>
            </p>
            <button type="button" class={PRIMARY_BUTTON} onClick={() => void signIn()}>
              Sign in with Lichess
            </button>
          </div>
        </Match>
      </Switch>
    </Card>
  );
}

function challengeLabel(challenge: Challenge): string {
  const speed =
    challenge.timeControl.type === "correspondence" ? "" : ` ${SPEED_NAMES[challenge.speed]}`;
  const variant = challenge.variant.key === "standard" ? "" : ` ${challenge.variant.name}`;
  return `${timeControlName(challenge.timeControl)}${speed}${variant} · ${challenge.rated ? "rated" : "casual"}`;
}

function ChallengesCard(props: {
  username: string;
  onExpectGame: (id: string) => void;
  notify: (message: string, tone?: "info" | "error") => void;
}) {
  const [busy, setBusy] = createSignal<string>();
  const respond = async (challenge: Challenge, action: "accept" | "decline" | "cancel") => {
    setBusy(challenge.id);
    try {
      if (action === "accept") props.onExpectGame(challenge.id);
      await lichessEvents.respond(challenge, action);
    } catch (reason) {
      props.notify(describeLichessError(toLichessError(reason)), "error");
    } finally {
      setBusy(undefined);
    }
  };
  const playable = (challenge: Challenge) => challenge.variant.key === "standard";

  return (
    <Card class="flex flex-col gap-2 px-[18px] py-3.5">
      <CardTitle>Challenges</CardTitle>
      <Show
        when={lichessEvents.challenges().length > 0}
        fallback={<EmptyState class="py-4">No challenges right now.</EmptyState>}
      >
        <ul class="flex flex-col gap-1.5">
          <For each={lichessEvents.challenges()}>
            {(challenge) => {
              const incoming = () => challengeDirection(challenge, props.username) === "in";
              const other = () => (incoming() ? challenge.challenger : challenge.destUser);
              return (
                <li class="flex items-center gap-2.5 rounded-xl bg-blush-50 px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-[14px]">
                      <span class="text-muted">{incoming() ? "From " : "To "}</span>
                      <span class="font-bold">
                        {other()?.title ? `${other()?.title} ` : ""}
                        {other()?.name ?? "anyone"}
                      </span>
                      <Show when={other()?.rating}>
                        <span class="text-ink/75"> {other()?.rating}</span>
                      </Show>
                    </p>
                    <p class="text-[12px] text-muted">{challengeLabel(challenge)}</p>
                  </div>
                  <Show
                    when={incoming()}
                    fallback={
                      <button
                        type="button"
                        class={SECONDARY_BUTTON}
                        disabled={busy() === challenge.id}
                        onClick={() => void respond(challenge, "cancel")}
                      >
                        Cancel
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class={PRIMARY_BUTTON}
                      disabled={busy() === challenge.id || !playable(challenge)}
                      title={
                        playable(challenge) ? undefined : "Only standard chess can be played here"
                      }
                      onClick={() => void respond(challenge, "accept")}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      class={SECONDARY_BUTTON}
                      disabled={busy() === challenge.id}
                      onClick={() => void respond(challenge, "decline")}
                    >
                      Decline
                    </button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </Card>
  );
}

function OngoingCard(props: { onOpenGame: (game: { id: string; color?: Color }) => void }) {
  const games = () =>
    [...lichessEvents.games()].sort(
      (a, b) =>
        Number(b.isMyTurn) - Number(a.isMyTurn) || (a.secondsLeft ?? 0) - (b.secondsLeft ?? 0),
    );
  const myTurns = () => games().filter((game) => game.isMyTurn).length;
  return (
    <Card class="flex flex-col gap-2 px-[18px] py-3.5">
      <div class="flex items-center gap-2">
        <CardTitle>Ongoing games</CardTitle>
        <Show when={myTurns() > 0}>
          <span class="rounded-full bg-rose px-2 py-px text-[12px] font-bold text-snow">
            {myTurns()} your turn
          </span>
        </Show>
        <button
          type="button"
          title="Refresh"
          aria-label="Refresh ongoing games"
          class="ml-auto grid size-7 place-items-center rounded-lg text-muted hover:bg-blush-100 hover:text-ink"
          onClick={() => void lichessEvents.refreshGames()}
        >
          <RetryIcon class="size-4" />
        </button>
      </div>
      <Show
        when={games().length > 0}
        fallback={
          <EmptyState class="py-4">
            No games in progress. Correspondence games wait here between moves.
          </EmptyState>
        }
      >
        <ul class="flex flex-col gap-1.5">
          <For each={games()}>{(game) => <OngoingRow game={game} onOpen={props.onOpenGame} />}</For>
        </ul>
      </Show>
    </Card>
  );
}

function OngoingRow(props: {
  game: GameInfo;
  onOpen: (game: { id: string; color?: Color }) => void;
}) {
  const game = () => props.game;
  const opponent = () =>
    game().opponent.ai ? `Lichess AI level ${game().opponent.ai}` : game().opponent.username;
  const speed = () => (game().speed ? SPEED_NAMES[game().speed ?? "rapid"] : "");
  return (
    <li>
      <button
        type="button"
        onClick={() => props.onOpen({ id: game().gameId, color: toColor(game().color) })}
        class="flex w-full items-center gap-2.5 rounded-xl bg-blush-50 px-3 py-2 text-left transition-colors hover:bg-blush-100"
      >
        <span
          aria-hidden="true"
          class={`size-3 shrink-0 rounded-[3px] ${
            game().color === "white"
              ? "border-[1.5px] border-plum bg-snow"
              : "bg-plum dark:ring-1 dark:ring-snow/40"
          }`}
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[14px]">
            <span class="font-bold">{opponent()}</span>
            <Show when={game().opponent.rating}>
              <span class="text-ink/75"> {game().opponent.rating}</span>
            </Show>
          </p>
          <p class="text-[12px] text-muted">
            {speed()}
            {game().rated ? " · rated" : ""}
          </p>
        </div>
        <Show when={game().secondsLeft != null}>
          <span class="shrink-0 font-mono text-[13px] text-muted">
            {formatClock((game().secondsLeft ?? 0) * 1000)}
          </span>
        </Show>
        <span
          class={`shrink-0 rounded-full px-2 py-px text-[12px] font-bold ${
            game().isMyTurn ? "bg-rose text-snow" : "bg-white text-muted ring-1 ring-blush-200"
          }`}
        >
          {game().isMyTurn ? "Your turn" : "Their turn"}
        </span>
      </button>
    </li>
  );
}
