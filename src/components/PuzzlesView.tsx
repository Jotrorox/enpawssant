// The Purrzles section: puzzles from the Lichess puzzle database. Rated mode picks puzzles near
// the player's rating and moves it after every first try; streak mode gets harder with every solve
// and ends at the first mistake.

import { batch, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { type Square, START_FEN } from "../chess/board";
import { formatSize } from "../chess/files";
import type { PgnGame } from "../chess/pgn";
import {
  cancelPuzzleDownload,
  type DownloadProgress,
  downloadPuzzles,
  finishRun,
  judgeMove,
  type Mode,
  nextPuzzle,
  openPuzzleGame,
  type Profile,
  type PuzzleData,
  playUci,
  puzzleGame,
  puzzleStatus,
  recordPuzzle,
  resetPuzzleProgress,
  solverSide,
  streakTarget,
  THEMES,
  themeLabel,
} from "../chess/puzzles";
import { type MoveInput, makeMove } from "../chess/rules";
import { playSound, setSoundEnabled, soundEnabled } from "../chess/sound";
import { Board } from "./Board";
import {
  BulbIcon,
  CatIcon,
  ChartIcon,
  DownloadIcon,
  ExternalIcon,
  FlameIcon,
  NextIcon,
  SoundOffIcon,
  SoundOnIcon,
} from "./Icons";
import {
  Card,
  CardTitle,
  IconButton,
  INPUT,
  PRIMARY_BUTTON,
  ProgressBar,
  SECONDARY_BUTTON,
  Segmented,
} from "./ui";

const MODES = [
  { value: "rated", label: "Rated" },
  { value: "streak", label: "Streak" },
] as const;

/** Pause before the opponent's first move, so the solver sees what happened. */
const INTRO_MS = 700;
/** Pause before the opponent answers a correct move. */
const REPLY_MS = 450;
/** How long a wrong move stays on the board before it is taken back. */
const WRONG_MS = 650;
const SOLUTION_STEP_MS = 750;

type Phase =
  | "loading"
  /** The opponent is about to move or answering; the board is locked. */
  | "waiting"
  | "playing"
  | "solved"
  /** Finished without solving: the solution was shown or a streak ended. */
  | "over"
  | "empty";

type Feedback =
  | "loading"
  | "watch"
  | "find"
  | "good"
  | "wrong"
  | "solved"
  | "solvedLate"
  | "solution"
  | "streakOver"
  | "empty";

type Round = {
  puzzle?: PuzzleData;
  fen: string;
  /** Index of the next move in `puzzle.moves`. */
  index: number;
  lastMove?: { from: Square; to: Square };
  phase: Phase;
  feedback: Feedback;
  /** A wrong move, a hint or the solution was used: it no longer counts as solved. */
  missed: boolean;
  recorded: boolean;
  /** 0: none, 1: the piece to move, 2: the whole move. */
  hint: 0 | 1 | 2;
  ratingChange: number | null;
};

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

const moveOf = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) });

export function PuzzlesView(props: {
  onAnalyze: (game: PgnGame, position: number[]) => void;
  notify: (message: string, tone?: "info" | "error") => void;
}) {
  const [status, { mutate, refetch }] = createResource(puzzleStatus);
  const [mode, setMode] = createSignal<Mode>("rated");
  const [theme, setTheme] = createSignal("");
  const [run, setRun] = createSignal(0);
  const [round, setRound] = createStore<Round>({
    fen: START_FEN,
    index: 0,
    phase: "loading",
    feedback: "loading",
    missed: false,
    recorded: false,
    hint: 0,
    ratingChange: null,
  });
  const [download, setDownload] = createSignal<DownloadProgress | "starting">();

  let timers: number[] = [];
  const later = (ms: number, action: () => void) => {
    timers.push(window.setTimeout(action, ms));
  };
  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  onCleanup(clearTimers);

  const sound = (kind: Parameters<typeof playSound>[0]) => {
    if (soundEnabled()) playSound(kind);
  };

  const setProfile = (profile: Profile) => {
    const current = status();
    if (current) mutate({ ...current, profile });
  };

  // --- Playing -----------------------------------------------------------------------------------

  let loadRequest = 0;
  const load = async () => {
    clearTimers();
    const current = ++loadRequest;
    setRound({ phase: "loading", feedback: "loading", hint: 0, lastMove: undefined });
    try {
      const puzzle = await nextPuzzle({
        target: mode() === "streak" ? streakTarget(run()) : undefined,
        theme: mode() === "rated" ? theme() || undefined : undefined,
        exclude: round.puzzle ? [round.puzzle.id] : [],
      });
      if (current !== loadRequest) return;
      if (!puzzle) {
        setRound({ puzzle: undefined, phase: "empty", feedback: "empty" });
        return;
      }
      start(puzzle);
    } catch (e) {
      if (current !== loadRequest) return;
      setRound({ phase: "empty", feedback: "empty" });
      props.notify(`Mochi couldn't find a puzzle: ${errorMessage(e)}`, "error");
    }
  };

  const start = (puzzle: PuzzleData) => {
    setRound({
      puzzle,
      fen: puzzle.fen,
      index: 0,
      lastMove: undefined,
      phase: "waiting",
      feedback: "watch",
      missed: false,
      recorded: false,
      hint: 0,
      ratingChange: null,
    });
    later(INTRO_MS, opponentMove);
  };

  /** Plays the opponent's move at `round.index`. */
  const opponentMove = () => {
    const puzzle = round.puzzle;
    if (!puzzle) return;
    const uci = puzzle.moves[round.index];
    const result = uci ? playUci(round.fen, uci) : undefined;
    if (!result) return;
    setRound({
      fen: result.fen,
      lastMove: moveOf(uci),
      index: round.index + 1,
      phase: "playing",
      hint: 0,
      feedback: round.feedback === "watch" ? "find" : round.feedback,
    });
  };

  const record = async (solved: boolean) => {
    const puzzle = round.puzzle;
    if (!puzzle || round.recorded) return;
    setRound("recorded", true);
    try {
      const result = await recordPuzzle(puzzle.id, mode(), solved);
      setProfile(result.profile);
      if (round.puzzle?.id === puzzle.id) setRound("ratingChange", result.ratingChange);
    } catch (e) {
      props.notify(`Mochi couldn't save the result: ${errorMessage(e)}`, "error");
    }
  };

  /** Counts the puzzle as missed, once. */
  const miss = () => {
    if (round.missed) return;
    setRound("missed", true);
    void record(false);
  };

  const endStreak = async () => {
    const length = run();
    setRound({ phase: "over", feedback: "streakOver" });
    try {
      setProfile(await finishRun(length));
    } catch (e) {
      props.notify(`Mochi couldn't save the streak: ${errorMessage(e)}`, "error");
    }
  };

  const onMove = (input: MoveInput) => {
    const puzzle = round.puzzle;
    if (!puzzle || round.phase !== "playing") return;
    const result = makeMove(round.fen, input);
    if (!result) return;
    const verdict = judgeMove(puzzle, round.index, result);
    const before = { fen: round.fen, lastMove: round.lastMove };

    if (verdict === "wrong") {
      // Show the move, then take it back.
      setRound({
        fen: result.fen,
        lastMove: moveOf(result.uci),
        phase: "waiting",
        feedback: "wrong",
      });
      sound("illegal");
      miss();
      later(WRONG_MS, () => {
        setRound({ fen: before.fen, lastMove: before.lastMove, hint: 0 });
        if (mode() === "streak") void endStreak();
        else setRound("phase", "playing");
      });
      return;
    }

    batch(() => {
      setRound({ fen: result.fen, lastMove: moveOf(result.uci), index: round.index + 1, hint: 0 });
      if (verdict === "solved") {
        setRound({ phase: "solved", feedback: round.missed ? "solvedLate" : "solved" });
      } else {
        setRound({ phase: "waiting", feedback: "good" });
      }
    });
    if (verdict === "solved") {
      later(260, () => sound("promote"));
      if (!round.missed) {
        void record(true);
        if (mode() === "streak") setRun((n) => n + 1);
      }
      return;
    }
    later(REPLY_MS, opponentMove);
  };

  const hint = () => {
    if (!round.puzzle || round.phase !== "playing" || round.hint >= 2) return;
    miss();
    setRound("hint", (level) => (level + 1) as 1 | 2);
  };

  const showSolution = () => {
    const puzzle = round.puzzle;
    if (!puzzle || (round.phase !== "playing" && round.phase !== "waiting")) return;
    clearTimers();
    miss();
    setRound({ phase: "over", feedback: "solution", hint: 0 });
    const step = () => {
      const uci = puzzle.moves[round.index];
      if (!uci || round.puzzle?.id !== puzzle.id) return;
      const result = playUci(round.fen, uci);
      if (!result) return;
      setRound({ fen: result.fen, lastMove: moveOf(uci), index: round.index + 1 });
      later(SOLUTION_STEP_MS, step);
    };
    later(250, step);
  };

  const hintArrows = () => {
    const uci = round.puzzle?.moves[round.index];
    if (!uci || round.phase !== "playing" || round.hint === 0) return [];
    const { from, to } = moveOf(uci);
    return [{ from, to: round.hint === 1 ? from : to, strength: 0.9 }];
  };

  const changeMode = (next: Mode) => {
    if (next === mode()) return;
    // Leaving a streak ends it.
    if (mode() === "streak" && run() > 0 && round.phase !== "over")
      void finishRun(run()).then(setProfile);
    setMode(next);
    setRun(0);
    void load();
  };

  const newRun = () => {
    setRun(0);
    void load();
  };

  const analyze = () => {
    const puzzle = round.puzzle;
    if (puzzle) props.onAnalyze(puzzleGame(puzzle), [0]);
  };

  void load();

  // --- Library -----------------------------------------------------------------------------------

  const startDownload = async () => {
    setDownload("starting");
    try {
      const imported = await downloadPuzzles(setDownload);
      if (imported !== null) {
        props.notify(`${imported.toLocaleString("en-US")} Lichess puzzles are ready to solve.`);
      }
    } catch (e) {
      props.notify(`The puzzle download failed: ${errorMessage(e)}`, "error");
    } finally {
      setDownload(undefined);
      void refetch();
    }
  };

  const resetProgress = async () => {
    if (!window.confirm("Forget your puzzle rating, streaks and every puzzle you've played?"))
      return;
    try {
      mutate(await resetPuzzleProgress());
    } catch (e) {
      props.notify(`Mochi couldn't reset your progress: ${errorMessage(e)}`, "error");
    }
  };

  const side = () => (round.puzzle ? solverSide(round.puzzle) : "w");
  const sideName = () => (side() === "w" ? "White" : "Black");
  const done = () => round.phase === "solved" || round.phase === "over";

  return (
    <div class="grid h-full grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)] gap-3.5">
      <div class="flex min-h-0 min-w-0 flex-col pt-4 pb-3.5 pl-[18px]">
        <div class="mb-1 flex min-h-[30px] items-center gap-3">
          <h1 class="flex items-center gap-2 font-display text-[17px] font-semibold">
            <span
              class={`size-3 rounded-[3px] ${side() === "w" ? "border-[1.5px] border-plum bg-white" : "bg-plum"}`}
              aria-hidden="true"
            />
            {round.phase === "loading" ? "Fetching a purrzle…" : `${sideName()} to play`}
          </h1>
          <Show when={round.puzzle && done()}>
            <span class="ml-auto rounded-xl border border-blush-200 bg-white px-2.5 py-1 text-[13px] font-bold">
              Puzzle rating <span class="font-mono">{round.puzzle?.rating}</span>
            </span>
          </Show>
        </div>

        <div class="flex min-h-0 flex-1 flex-col justify-center [container-type:size]">
          <div class="board-fit-solo mx-auto">
            <Board
              fen={round.fen}
              orientation={side()}
              lastMove={round.lastMove}
              arrows={hintArrows()}
              onMove={round.phase === "playing" ? onMove : undefined}
              sound={soundEnabled()}
            />
          </div>
        </div>

        <div class="mt-3 flex items-center gap-2">
          <IconButton
            label={soundEnabled() ? "Mute move sounds" : "Unmute move sounds"}
            onClick={() => setSoundEnabled(!soundEnabled())}
          >
            <Show when={soundEnabled()} fallback={<SoundOffIcon />}>
              <SoundOnIcon />
            </Show>
          </IconButton>
          <Show when={mode() === "rated" && !done()}>
            <button
              type="button"
              class={SECONDARY_BUTTON}
              disabled={round.phase !== "playing" || round.hint >= 2}
              title="Using a hint counts as a miss"
              onClick={hint}
            >
              <BulbIcon class="size-[18px]" />
              {round.hint === 0 ? "Hint" : "Another hint"}
            </button>
            <button
              type="button"
              class={SECONDARY_BUTTON}
              disabled={round.phase !== "playing"}
              onClick={showSolution}
            >
              Solution
            </button>
          </Show>
          <Show when={done() && round.puzzle}>
            <button type="button" class={SECONDARY_BUTTON} onClick={analyze}>
              <ChartIcon class="size-[18px]" />
              Analyze on the board
            </button>
          </Show>
          <Show
            when={mode() === "streak" && round.feedback === "streakOver"}
            fallback={
              <button
                type="button"
                class={`${PRIMARY_BUTTON} ml-auto`}
                disabled={round.phase === "loading" || (mode() === "streak" && !done())}
                onClick={() => void load()}
              >
                {done() || round.phase === "empty" ? "Next purrzle" : "Skip"}
                <NextIcon class="size-[18px]" />
              </button>
            }
          >
            <button type="button" class={`${PRIMARY_BUTTON} ml-auto`} onClick={newRun}>
              <FlameIcon class="size-[18px]" />
              New streak
            </button>
          </Show>
        </div>
      </div>

      <div class="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto pt-3.5 pr-3.5 pb-3.5">
        <Segmented
          label="Puzzle mode"
          options={MODES}
          value={mode()}
          onChange={changeMode}
          class="shrink-0 border border-blush-200/80 bg-blush-100/80"
        />

        <FeedbackCard
          feedback={round.feedback}
          side={sideName()}
          ratingChange={round.ratingChange}
          run={run()}
          mode={mode()}
        />

        <Show when={done() && round.puzzle}>
          {(puzzle) => (
            <Card class="shrink-0 px-[18px] pt-3 pb-3.5">
              <div class="mb-2 flex items-center gap-2">
                <CardTitle>About this purrzle</CardTitle>
                <Show when={puzzle().gameUrl}>
                  <button
                    type="button"
                    class="ml-auto flex items-center gap-1 text-[12px] font-semibold text-muted hover:text-ink"
                    onClick={() =>
                      void openPuzzleGame(puzzle().gameUrl).catch((e) =>
                        props.notify(errorMessage(e), "error"),
                      )
                    }
                  >
                    Original game
                    <ExternalIcon class="size-3.5" />
                  </button>
                </Show>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <For each={puzzle().themes}>
                  {(key) => (
                    <span class="rounded-full bg-blush-100 px-2.5 py-0.5 text-[12px] font-semibold">
                      {themeLabel(key)}
                    </span>
                  )}
                </For>
              </div>
              <p class="mt-2 text-[12px] text-muted">
                Played {puzzle().plays.toLocaleString("en-US")} times on Lichess · liked by{" "}
                {Math.round((puzzle().popularity + 100) / 2)}%
              </p>
            </Card>
          )}
        </Show>

        <ProfileCard profile={status()?.profile} history={status()?.history ?? []} />

        <Show
          when={mode() === "rated"}
          fallback={
            <Card class="shrink-0 px-[18px] py-3">
              <div class="flex items-center gap-3">
                <FlameIcon class="size-6 text-rose" />
                <div class="min-w-0 flex-1">
                  <p class="text-[14px] font-bold">{run()} solved in this streak</p>
                  <p class="text-[12px] text-muted">
                    Next puzzle around {streakTarget(run())} · one mistake ends the streak
                  </p>
                </div>
              </div>
            </Card>
          }
        >
          <Card class="shrink-0 px-[18px] py-3">
            <label class="flex items-center gap-3">
              <span class="text-[14px] font-bold">Theme</span>
              <select
                value={theme()}
                onChange={(event) => {
                  setTheme(event.currentTarget.value);
                  void load();
                }}
                class={`${INPUT} ml-auto h-8 w-52 text-[13px]`}
              >
                <For each={THEMES}>
                  {(entry) => <option value={entry.value}>{entry.label}</option>}
                </For>
              </select>
            </label>
          </Card>
        </Show>

        <Card class="shrink-0 px-[18px] pt-3 pb-3.5">
          <div class="mb-1 flex items-center gap-2">
            <CardTitle>Puzzle library</CardTitle>
            <button
              type="button"
              class="ml-auto text-[12px] font-semibold text-muted underline-offset-2 hover:text-ink hover:underline"
              onClick={() => void resetProgress()}
            >
              Reset progress
            </button>
          </div>
          <p class="text-[13px] text-muted">
            <Show when={status()} fallback="Counting puzzles…">
              {(info) => (
                <>
                  {info().count.toLocaleString("en-US")}{" "}
                  {info().source === "lichess"
                    ? "puzzles from the Lichess puzzle database (CC0)."
                    : "starter puzzles from the Lichess puzzle database (CC0)."}
                </>
              )}
            </Show>
          </p>
          <Show
            when={download()}
            fallback={
              <Show when={status()?.source === "starter"}>
                <p class="mt-2 text-[12px] leading-snug text-muted">
                  Download the full database for over a million well-liked puzzles. It is about 300
                  MB to download and takes about as much disk space.
                </p>
                <button
                  type="button"
                  class={`${SECONDARY_BUTTON} mt-2.5`}
                  onClick={() => void startDownload()}
                >
                  <DownloadIcon class="size-[18px]" />
                  Download all puzzles
                </button>
              </Show>
            }
          >
            {(progress) => <DownloadStatus progress={progress()} />}
          </Show>
        </Card>
      </div>
    </div>
  );
}

function FeedbackCard(props: {
  feedback: Feedback;
  side: string;
  ratingChange: number | null;
  run: number;
  mode: Mode;
}) {
  const text = (): { title: string; detail: string; tone: "plain" | "good" | "bad" } => {
    switch (props.feedback) {
      case "loading":
        return { title: "One moment…", detail: "Mochi is picking a purrzle.", tone: "plain" };
      case "watch":
        return { title: "Watch closely", detail: "Your opponent is about to move.", tone: "plain" };
      case "find":
        return {
          title: "Your move",
          detail: `Find the best move for ${props.side}.`,
          tone: "plain",
        };
      case "good":
        return { title: "Purrfect!", detail: "That's the move. Keep going.", tone: "good" };
      case "wrong":
        return props.mode === "streak"
          ? { title: "Not that one", detail: "So close.", tone: "bad" }
          : {
              title: "Not quite",
              detail: "That's not the move. Have another look.",
              tone: "bad",
            };
      case "solved":
        return {
          title: "Solved!",
          detail:
            props.mode === "streak"
              ? `${props.run} in a row. On to a harder one!`
              : props.ratingChange === null
                ? "Nicely done."
                : `Your rating goes ${props.ratingChange >= 0 ? "up" : "down"} by ${Math.abs(Math.round(props.ratingChange))}.`,
          tone: "good",
        };
      case "solvedLate":
        return {
          title: "Got there",
          detail:
            props.ratingChange === null
              ? "Well found, though it doesn't count as solved."
              : `It counts as a miss this time: ${Math.round(props.ratingChange)} rating.`,
          tone: "plain",
        };
      case "solution":
        return {
          title: "Here's the solution",
          detail:
            props.ratingChange === null
              ? "Watch how it goes."
              : `${Math.round(props.ratingChange)} rating. Watch how it goes.`,
          tone: "plain",
        };
      case "streakOver":
        return {
          title: "Streak over",
          detail: `You solved ${props.run} ${props.run === 1 ? "puzzle" : "puzzles"} in a row.`,
          tone: "bad",
        };
      case "empty":
        return {
          title: "No purrzles here",
          detail: "Try another theme, or download the full puzzle database.",
          tone: "plain",
        };
    }
  };
  return (
    <div
      aria-live="polite"
      class={`flex shrink-0 items-start gap-3 rounded-[20px] border px-[18px] py-3.5 shadow-card ${
        text().tone === "good"
          ? "border-nag-good/30 bg-[#eef8f0]"
          : text().tone === "bad"
            ? "border-nag-mistake/25 bg-[#fdf0f0]"
            : "border-blush-200/80 bg-lavender"
      }`}
    >
      <span class="grid size-9 shrink-0 place-items-center rounded-full bg-white text-ink">
        <CatIcon class="size-[22px]" />
      </span>
      <div class="min-w-0">
        <p class="font-display text-[17px] font-semibold">{text().title}</p>
        <p class="text-[13px] leading-snug">{text().detail}</p>
      </div>
    </div>
  );
}

function ProfileCard(props: { profile?: Profile; history: { mode: Mode; ratingAfter: number }[] }) {
  /** Rating after each rated attempt, oldest first. */
  const points = () =>
    props.history
      .filter((attempt) => attempt.mode === "rated")
      .map((attempt) => attempt.ratingAfter)
      .reverse();
  const sparkline = () => {
    const values = points();
    if (values.length < 2) return undefined;
    const min = Math.min(...values) - 5;
    const max = Math.max(...values) + 5;
    return values
      .map(
        (value, i) =>
          `${(i / (values.length - 1)) * 100},${30 - ((value - min) / (max - min)) * 30}`,
      )
      .join(" ");
  };

  return (
    <Card class="shrink-0 px-[18px] pt-3 pb-3.5">
      <Show when={props.profile} fallback={<p class="text-[13px] text-muted">Loading…</p>}>
        {(profile) => (
          <>
            <div class="flex items-end gap-4">
              <div>
                <p class="text-[11px] font-bold tracking-[0.08em] text-ink/70 uppercase">
                  Puzzle rating
                </p>
                <p class="font-display text-[30px] leading-none font-semibold">
                  {Math.round(profile().rating)}
                  <Show when={profile().rated < 20}>
                    <span class="ml-1 align-top text-[14px] text-muted" title="Still settling in">
                      ?
                    </span>
                  </Show>
                </p>
              </div>
              <Show when={sparkline()}>
                {(line) => (
                  <svg
                    viewBox="0 0 100 30"
                    preserveAspectRatio="none"
                    class="h-9 min-w-0 flex-1"
                    role="img"
                    aria-label="Rating over your recent puzzles"
                  >
                    <polyline
                      points={line()}
                      fill="none"
                      stroke="var(--color-rose)"
                      stroke-width="2"
                      stroke-linejoin="round"
                      vector-effect="non-scaling-stroke"
                    />
                  </svg>
                )}
              </Show>
            </div>
            <dl class="mt-3 grid grid-cols-4 gap-2 text-center">
              <Stat label="Solved" value={profile().solved} />
              <Stat label="Missed" value={profile().failed} />
              <Stat
                label="In a row"
                value={profile().solveStreak}
                title={`Best: ${profile().bestSolveStreak}`}
              />
              <Stat label="Best streak" value={profile().bestRun} />
            </dl>
          </>
        )}
      </Show>
    </Card>
  );
}

function Stat(props: { label: string; value: number; title?: string }) {
  return (
    <div class="rounded-xl bg-blush-100/70 px-1 py-1.5" title={props.title}>
      <dt class="text-[11px] font-semibold text-muted">{props.label}</dt>
      <dd class="font-mono text-[15px] font-bold">{props.value.toLocaleString("en-US")}</dd>
    </div>
  );
}

function DownloadStatus(props: { progress: DownloadProgress | "starting" }) {
  const info = () => (props.progress === "starting" ? undefined : props.progress);
  const label = () => {
    const progress = info();
    if (!progress) return "Connecting to database.lichess.org…";
    if (progress.phase === "download") {
      return `Downloading ${formatSize(progress.bytes)}${
        progress.total ? ` of ${formatSize(progress.total)}` : ""
      }`;
    }
    return `Unpacking: ${progress.imported.toLocaleString("en-US")} puzzles kept so far`;
  };
  const fraction = () => {
    const progress = info();
    return progress?.total ? progress.bytes / progress.total : undefined;
  };
  return (
    <div class="mt-2.5 flex flex-col gap-2">
      <p class="text-[13px] font-semibold">{label()}</p>
      <ProgressBar label="Puzzle download" fraction={fraction()} />
      <button
        type="button"
        class={`${SECONDARY_BUTTON} self-start`}
        onClick={() => void cancelPuzzleDownload()}
      >
        Stop
      </button>
    </div>
  );
}
