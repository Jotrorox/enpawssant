import { createSignal, For, Show } from "solid-js";
import type { Arrow, Color, Square } from "../chess/board";
import type { MoveInput } from "../chess/rules";
import { barLabel, formatScore, plotPawns, type Score, whiteShare } from "../chess/score";
import { setSoundEnabled, soundEnabled } from "../chess/sound";
import type { GameInfo, Player } from "../game/session";
import { Board } from "./Board";
import {
  ChartIcon,
  CheckIcon,
  CopyIcon,
  ExportIcon,
  FirstIcon,
  FlipIcon,
  ImportIcon,
  LastIcon,
  NextIcon,
  PencilIcon,
  PrevIcon,
  SoundOffIcon,
  SoundOnIcon,
} from "./Icons";
import { Card, IconButton } from "./ui";

type BoardPanelProps = {
  info: GameInfo;
  /** Index of the shown position in the current line; 0 is the starting position. */
  ply: number;
  maxPly: number;
  fen: string;
  /** White-relative evaluation per position of the current line, where one is known. */
  evals: (Score | undefined)[];
  lastMove?: { from: Square; to: Square };
  arrows?: Arrow[];
  orientation: Color;
  onFlip: () => void;
  onPly: (ply: number) => void;
  onMove: (move: MoveInput) => void;
  onImport: () => void;
  onExport: () => void;
};

export function BoardPanel(props: BoardPanelProps) {
  return (
    <div class="flex min-h-0 min-w-0 flex-col pt-4 pb-3.5 pl-[18px]">
      <GameHeader info={props.info} />

      <div class="flex min-h-0 flex-1 flex-col justify-center [container-type:size]">
        <div class="board-fit mx-auto flex gap-[18px]">
          <EvalBar score={props.evals[props.ply]} orientation={props.orientation} />
          <div class="min-w-0 flex-1">
            <Board
              fen={props.fen}
              orientation={props.orientation}
              lastMove={props.lastMove}
              arrows={props.arrows}
              onMove={props.onMove}
              sound={soundEnabled()}
            />
          </div>
        </div>
      </div>

      <BoardToolbar
        ply={props.ply}
        maxPly={props.maxPly}
        fen={props.fen}
        onFlip={props.onFlip}
        onPly={props.onPly}
        onImport={props.onImport}
        onExport={props.onExport}
      />

      <EvalGraph
        info={props.info}
        evals={props.evals}
        ply={props.ply}
        maxPly={props.maxPly}
        onPly={props.onPly}
      />
    </div>
  );
}

function GameHeader(props: { info: GameInfo }) {
  return (
    <div class="mb-1 flex min-h-[30px] items-center gap-3">
      <h1 class="flex min-w-0 items-center gap-2 text-[15px] whitespace-nowrap">
        <span class="size-3 rounded-[3px] border-[1.5px] border-plum bg-white" aria-hidden="true" />
        <PlayerName player={props.info.white} />
        <span class="px-1 text-ink/60">vs</span>
        <span class="size-3 rounded-[3px] bg-plum" aria-hidden="true" />
        <PlayerName player={props.info.black} />
      </h1>
      <Show when={props.info.eco || props.info.opening}>
        <div class="ml-auto flex min-w-0 items-center gap-2 rounded-xl border border-blush-200 bg-white px-2.5 py-1 text-[13px] font-bold">
          <Show when={props.info.eco}>
            <span class="font-mono text-rose-strong">{props.info.eco}</span>
          </Show>
          <span class="truncate">{props.info.opening}</span>
        </div>
      </Show>
    </div>
  );
}

function PlayerName(props: { player: Player }) {
  return (
    <>
      <span class="truncate font-bold">{props.player.name}</span>
      <Show when={props.player.rating}>
        <span class="text-ink/75">{props.player.rating}</span>
      </Show>
    </>
  );
}

function EvalBar(props: { score?: Score; orientation: Color }) {
  const share = () => (props.score ? whiteShare(props.score) : 0.5);
  const blackOnTop = () => props.orientation === "w";

  return (
    <div
      role="img"
      aria-label={props.score ? `Evaluation ${formatScore(props.score)}` : "No evaluation yet"}
      class={`relative mt-[30px] flex w-[22px] shrink-0 overflow-hidden rounded-full bg-white ring-1 ring-blush-200 ${
        blackOnTop() ? "flex-col" : "flex-col-reverse"
      }`}
    >
      <div
        class="shrink-0 bg-plum transition-[height] duration-300"
        style={{ height: `${(1 - share()) * 100}%` }}
      />
      <span
        aria-hidden="true"
        class={`w-full text-center font-mono text-[8.5px] leading-[1.8] tracking-tighter ${
          share() >= 0.5 ? "text-ink" : "text-ink/60"
        }`}
      >
        {props.score ? barLabel(props.score) : "…"}
      </span>
    </div>
  );
}

function BoardToolbar(props: {
  ply: number;
  maxPly: number;
  fen: string;
  onFlip: () => void;
  onPly: (ply: number) => void;
  onImport: () => void;
  onExport: () => void;
}) {
  const [copied, setCopied] = createSignal(false);
  let resetTimer: number | undefined;

  const copyFen = async () => {
    try {
      await navigator.clipboard.writeText(props.fen);
      setCopied(true);
      clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div class="mt-3 mb-3 flex items-center gap-1 pl-[54px]">
      <IconButton label="Flip board" onClick={() => props.onFlip()}>
        <FlipIcon />
      </IconButton>
      <IconButton label="Edit position">
        <PencilIcon />
      </IconButton>
      <IconButton label={copied() ? "FEN copied" : "Copy FEN"} onClick={copyFen}>
        <Show when={copied()} fallback={<CopyIcon />}>
          <CheckIcon class="size-5 text-nag-good" />
        </Show>
      </IconButton>
      <IconButton label="Import PGN" onClick={() => props.onImport()}>
        <ImportIcon />
      </IconButton>
      <IconButton label="Export PGN" onClick={() => props.onExport()}>
        <ExportIcon />
      </IconButton>
      <IconButton
        label={soundEnabled() ? "Mute move sounds" : "Unmute move sounds"}
        onClick={() => setSoundEnabled(!soundEnabled())}
      >
        <Show when={soundEnabled()} fallback={<SoundOffIcon />}>
          <SoundOnIcon />
        </Show>
      </IconButton>

      <div class="mx-2 h-6 w-px bg-blush-200" aria-hidden="true" />

      <IconButton
        boxed
        label="First move"
        disabled={props.ply === 0}
        onClick={() => props.onPly(0)}
      >
        <FirstIcon />
      </IconButton>
      <IconButton
        boxed
        label="Previous move"
        disabled={props.ply === 0}
        onClick={() => props.onPly(props.ply - 1)}
      >
        <PrevIcon />
      </IconButton>
      <IconButton
        boxed
        label="Next move"
        disabled={props.ply === props.maxPly}
        onClick={() => props.onPly(props.ply + 1)}
      >
        <NextIcon />
      </IconButton>
      <IconButton
        boxed
        label="Last move"
        disabled={props.ply === props.maxPly}
        onClick={() => props.onPly(props.maxPly)}
      >
        <LastIcon />
      </IconButton>

      <button
        type="button"
        class="ml-auto flex h-9 items-center gap-2.5 rounded-xl bg-blush-400 px-5 text-[14px] font-bold whitespace-nowrap text-ink shadow-[inset_0_-2px_0_rgb(224_112_143/0.6)] transition-colors hover:bg-blush-300"
      >
        <ChartIcon class="size-[18px]" />
        Analyze full game
      </button>
    </div>
  );
}

function EvalGraph(props: {
  info: GameInfo;
  evals: (Score | undefined)[];
  ply: number;
  maxPly: number;
  onPly: (ply: number) => void;
}) {
  const HEIGHT = 40;
  const MID = HEIGHT / 2;
  const x = (ply: number) => (props.maxPly === 0 ? 0 : (ply / props.maxPly) * 100);
  const y = (score: Score) => MID - (MID - 3) * Math.tanh(plotPawns(score) / 1.2);
  /** Runs of consecutive analysed plies; unanalysed plies leave gaps. */
  const runs = () => {
    const result: { first: number; last: number; points: string[] }[] = [];
    props.evals.forEach((score, ply) => {
      if (!score) return;
      const run = result[result.length - 1];
      const point = `${x(ply)},${y(score)}`;
      if (run && run.last === ply - 1) {
        run.last = ply;
        run.points.push(point);
      } else {
        result.push({ first: ply, last: ply, points: [point] });
      }
    });
    return result.map((run) => ({ ...run, points: run.points.join(" ") }));
  };
  const current = () => props.evals[props.ply];

  const selectAt = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    props.onPly(Math.round(fraction * props.maxPly));
  };

  return (
    <Card class="px-[18px] pt-2.5 pb-4">
      <div class="mb-2 flex items-center gap-2 text-[13px]">
        <h2 class="mr-1 font-display text-[15px] font-semibold">Eval graph</h2>
        <Show when={props.info.accuracy}>
          {(accuracy) => (
            <>
              <span class="text-ink/70">Accuracy</span>
              <span class="rounded-full bg-blush-100 px-2.5 py-px font-bold">
                {props.info.white.name} {accuracy().white}
              </span>
              <span class="rounded-full bg-plum px-2.5 py-px font-bold text-white">
                {props.info.black.name} {accuracy().black}
              </span>
            </>
          )}
        </Show>
        <span class="ml-auto font-mono text-[12px] text-ink/75">
          ply {props.ply} / {props.maxPly}
        </span>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; moves are also reachable from the toolbar and notation. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: arrow keys already step through moves. */}
      <div class="relative h-[72px] cursor-pointer" onClick={selectAt}>
        <svg
          viewBox={`0 0 100 ${HEIGHT}`}
          preserveAspectRatio="none"
          class="absolute inset-0 size-full overflow-hidden rounded-[10px] bg-blush-100"
          role="img"
          aria-label="Evaluation over the game"
        >
          <For each={runs()}>
            {(run) => (
              <polygon
                points={`${x(run.first)},0 ${run.points} ${x(run.last)},0`}
                fill="var(--color-plum)"
              />
            )}
          </For>
          <line
            x1="0"
            x2="100"
            y1={MID}
            y2={MID}
            stroke="var(--color-rose)"
            stroke-width="1"
            stroke-dasharray="3 3"
            vector-effect="non-scaling-stroke"
            opacity="0.7"
          />
          <For each={runs()}>
            {(run) => (
              <polyline
                points={run.points}
                fill="none"
                stroke="var(--color-rose)"
                stroke-width="2"
                stroke-linejoin="round"
                vector-effect="non-scaling-stroke"
              />
            )}
          </For>
          <line
            x1={x(props.ply)}
            x2={x(props.ply)}
            y1="0"
            y2={HEIGHT}
            stroke="var(--color-rose)"
            stroke-width="2"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <Show when={current()}>
          {(score) => (
            <span
              class="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-rose"
              style={{
                left: `${x(props.ply)}%`,
                top: `${(y(score()) / HEIGHT) * 100}%`,
              }}
            />
          )}
        </Show>
      </div>
    </Card>
  );
}
