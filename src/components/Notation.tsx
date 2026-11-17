import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { moveNumberPrefix } from "../chess/board";
import { NAGS, type Nag, otherNagSymbols, qualityNag } from "../chess/nag";
import { header } from "../chess/pgn";
import type { ReviewNag } from "../chess/review";
import { formatScore, type Score } from "../chess/score";
import { type GameTree, isMainline, type NodeId, variationCount } from "../chess/tree";
import type { GameSession } from "../game/session";
import { PromoteIcon, TrashIcon } from "./Icons";
import { Card, CardTitle } from "./ui";

const NAG_STYLES: Record<Nag, { text: string; label: string }> = {
  "!!": { text: "text-nag-brilliant", label: "Brilliant move" },
  "!": { text: "text-nag-good", label: "Good move" },
  "!?": { text: "text-nag-interesting", label: "Interesting move" },
  "?!": { text: "text-nag-dubious", label: "Dubious move" },
  "?": { text: "text-nag-mistake", label: "Mistake" },
  "??": { text: "text-nag-mistake", label: "Blunder" },
};

type Token =
  | { kind: "move"; id: NodeId; prefix?: string }
  | { kind: "comment"; text: string }
  | { kind: "open" }
  | { kind: "close" };

/** The main line is split into paragraphs around the variations that branch off it. */
type Block = { kind: "main" | "variation"; tokens: Token[] };

/** Comment text without embedded commands such as `[%clk 0:03:00]`. */
function displayComment(comment: string | undefined): string | undefined {
  return comment?.replace(/\[%[^\]]*\]/g, "").trim() || undefined;
}

/** Appends a move with its comments. Returns whether Black's next move needs a move number. */
function pushMove(tree: GameTree, tokens: Token[], id: NodeId, forceNumber: boolean): boolean {
  const node = tree.nodes[id];
  const before = displayComment(node.startingComment);
  if (before) tokens.push({ kind: "comment", text: before });
  tokens.push({
    kind: "move",
    id,
    prefix: moveNumberPrefix(node.ply - 1, forceNumber || !!before),
  });
  const after = displayComment(node.comment);
  if (after) tokens.push({ kind: "comment", text: after });
  return !!after;
}

/** A variation starting with `firstId`, with nested variations in parentheses. */
function variationTokens(tree: GameTree, firstId: NodeId): Token[] {
  const tokens: Token[] = [];
  let forceNumber = pushMove(tree, tokens, firstId, true);
  let node = tree.nodes[firstId];
  while (node.children.length > 0) {
    const [mainId, ...alternatives] = node.children;
    forceNumber = pushMove(tree, tokens, mainId, forceNumber);
    for (const id of alternatives) {
      tokens.push({ kind: "open" }, ...variationTokens(tree, id), { kind: "close" });
      forceNumber = true;
    }
    node = tree.nodes[mainId];
  }
  return tokens;
}

function layout(tree: GameTree): Block[] {
  const blocks: Block[] = [];
  let tokens: Token[] = [];
  let forceNumber = true;
  let node = tree.nodes[tree.rootId];
  while (node.children.length > 0) {
    const [mainId, ...alternatives] = node.children;
    forceNumber = pushMove(tree, tokens, mainId, forceNumber);
    if (alternatives.length > 0) {
      blocks.push({ kind: "main", tokens });
      for (const id of alternatives) {
        blocks.push({ kind: "variation", tokens: variationTokens(tree, id) });
      }
      tokens = [];
      forceNumber = true;
    }
    node = tree.nodes[mainId];
  }
  if (tokens.length > 0) blocks.push({ kind: "main", tokens });
  return blocks;
}

type MenuState = { id: NodeId; x: number; y: number; trigger: HTMLElement };

/** What would have been better than the current move, when it is an inaccuracy or worse. */
export type BestMoveHint = {
  nag: ReviewNag;
  /** Missing until the engine has searched the position before the move. */
  best?: {
    /** The move with its number, e.g. `12... Nf6`. */
    label: string;
    /** Whether the move is already in the tree, as a variation. */
    inTree: boolean;
    /** Plays it as a variation (or goes to it) and moves there. */
    play: () => void;
  };
};

type NotationProps = {
  session: GameSession;
  /** Evaluation of the current position: the engine's, or the one the game was imported with. */
  score?: Score;
  bestMove?: BestMoveHint;
};

export function Notation(props: NotationProps) {
  const session = () => props.session;
  const tree = () => props.session.tree;
  const blocks = createMemo(() => layout(tree()));
  const variations = createMemo(() => variationCount(tree()));
  const atRoot = () => session().currentId() === tree().rootId;
  const currentNag = () => qualityNag(session().node().nags);
  const result = () => {
    const value = header({ headers: session().headers() }, "Result");
    return value === "*" ? undefined : value;
  };
  const [menu, setMenu] = createSignal<MenuState>();
  let scroller: HTMLDivElement | undefined;

  // Keep the current move in view while stepping through the game.
  createEffect(() => {
    const id = session().currentId();
    scroller?.querySelector(`[data-node="${id}"]`)?.scrollIntoView({ block: "nearest" });
  });

  const openMenu = (event: MouseEvent, id: NodeId) => {
    event.preventDefault();
    const trigger = event.currentTarget as HTMLElement;
    // Keyboard-opened menus (Shift+F10) report no pointer position.
    const rect = trigger.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({
      id,
      x: fromKeyboard ? rect.left : event.clientX,
      y: fromKeyboard ? rect.bottom : event.clientY,
      trigger,
    });
  };

  const renderToken = (token: Token) => (
    <Switch>
      <Match when={token.kind === "move" && token}>
        {(move) => (
          <MoveToken
            session={session()}
            id={move().id}
            prefix={move().prefix}
            score={props.score}
            onMenu={(event) => openMenu(event, move().id)}
          />
        )}
      </Match>
      <Match when={token.kind === "comment" && token}>
        {(comment) => <em class="selectable mr-1 text-[14px] text-ink/90">{comment().text} </em>}
      </Match>
      <Match when={token.kind === "open"}>(</Match>
      <Match when={token.kind === "close"}>
        <span class="mr-1">)</span>
      </Match>
    </Switch>
  );

  return (
    <Card class="flex min-h-[180px] flex-1 flex-col px-[18px] pt-3 pb-3.5">
      <div class="mb-2 flex items-center gap-3">
        <CardTitle>Paw prints</CardTitle>
        <span class="text-[12px] text-muted">
          Notation · {variations()} {variations() === 1 ? "variation" : "variations"}
        </span>
        <fieldset class="ml-auto flex gap-1.5">
          <legend class="sr-only">Annotate current move</legend>
          <For each={NAGS}>
            {(nag) => (
              <button
                type="button"
                title={NAG_STYLES[nag].label}
                aria-label={NAG_STYLES[nag].label}
                aria-pressed={currentNag() === nag}
                disabled={atRoot()}
                onClick={() => session().toggleNag(nag)}
                class={`h-7 min-w-8 rounded-lg px-1.5 text-[13px] font-bold transition-colors disabled:opacity-40 ${
                  NAG_STYLES[nag].text
                } ${
                  currentNag() === nag
                    ? "bg-white ring-2 ring-current"
                    : "bg-blush-100 hover:bg-blush-200"
                }`}
              >
                {nag}
              </button>
            )}
          </For>
        </fieldset>
      </div>

      <div ref={scroller} class="min-h-0 flex-1 overflow-y-auto pr-1 text-[15px] leading-[2]">
        <Show
          when={blocks().length > 0}
          fallback={
            <p class="text-[13px] text-muted">
              No paw prints yet. Play a move on the board or import a PGN.
            </p>
          }
        >
          <For each={blocks()}>
            {(block, index) =>
              block.kind === "main" ? (
                <p>
                  <For each={block.tokens}>{renderToken}</For>
                  <Show when={index() === blocks().length - 1 && result()}>
                    <span class="ml-1 font-bold text-ink/75">{result()}</span>
                  </Show>
                </p>
              ) : (
                <p class="my-1 ml-1 border-l-2 border-rose/60 pl-4 text-[14px] leading-relaxed text-ink/85">
                  <For each={block.tokens}>{renderToken}</For>
                </p>
              )
            }
          </For>
          <Show when={blocks()[blocks().length - 1]?.kind === "variation" && result()}>
            <p class="font-bold text-ink/75">{result()}</p>
          </Show>
        </Show>
      </div>

      <Show when={props.bestMove}>{(hint) => <BestMove hint={hint()} />}</Show>

      <div class="mt-2 flex items-center gap-3 rounded-xl bg-blush-100/70 px-3.5 py-2 text-[12px]">
        <span class="font-bold text-ink/70">FEN</span>
        <span class="selectable truncate font-mono text-ink">{session().node().fen}</span>
      </div>

      <Show when={menu()}>
        {(state) => (
          <MoveMenu
            state={state()}
            mainline={isMainline(tree(), state().id)}
            onPromote={() => session().promote(state().id)}
            onDelete={() => session().remove(state().id)}
            onClose={() => setMenu(undefined)}
          />
        )}
      </Show>
    </Card>
  );
}

function MoveToken(props: {
  session: GameSession;
  id: NodeId;
  prefix?: string;
  /** Evaluation of the current position, shown after the move when it is the current one. */
  score?: Score;
  onMenu: (event: MouseEvent) => void;
}) {
  const node = () => props.session.tree.nodes[props.id];
  const current = () => props.session.currentId() === props.id;
  const nag = () => qualityNag(node()?.nags ?? []);

  return (
    <Show when={node()}>
      {(node) => (
        <>
          <Show when={props.prefix}>
            <span class="text-ink/75">{props.prefix} </span>
          </Show>
          <button
            type="button"
            data-node={props.id}
            aria-current={current() ? "step" : undefined}
            onClick={() => props.session.goTo(props.id)}
            onContextMenu={(event) => props.onMenu(event)}
            class={`rounded-lg px-[3px] transition-colors ${
              current() ? "bg-blush-300 font-bold" : "hover:bg-blush-100"
            } ${nag() ? `${NAG_STYLES[nag() as Nag].text} font-bold` : ""}`}
          >
            {node().move?.san}
            {nag()}
            {otherNagSymbols(node().nags)}
          </button>
          <Show when={current() && props.score}>
            {(score) => (
              <span class="ml-1.5 font-mono text-[12px] text-ink/75">{formatScore(score())}</span>
            )}
          </Show>{" "}
        </>
      )}
    </Show>
  );
}

function BestMove(props: { hint: BestMoveHint }) {
  const style = () => NAG_STYLES[props.hint.nag];
  return (
    <div
      class="mt-2 flex min-h-10 items-center gap-2 rounded-xl border border-blush-200 bg-white py-1 pr-1.5 pl-3.5 text-[13px]"
      aria-live="polite"
    >
      <span class={`font-bold ${style().text}`}>
        {props.hint.nag} {style().label}
      </span>
      <Show
        when={props.hint.best}
        fallback={<span class="text-muted">· Step back to let Mochi find a better move.</span>}
      >
        {(best) => (
          <>
            <span class="min-w-0 truncate">
              · <span class="font-bold">{best().label}</span> was best
            </span>
            <button
              type="button"
              onClick={() => best().play()}
              class="ml-auto h-8 shrink-0 rounded-lg bg-blush-100 px-3 text-[13px] font-bold text-ink transition-colors hover:bg-blush-200"
            >
              {best().inTree ? "Go to variation" : "Add as variation"}
            </button>
          </>
        )}
      </Show>
    </div>
  );
}

function MoveMenu(props: {
  state: MenuState;
  mainline: boolean;
  onPromote: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  let menuEl!: HTMLDivElement;
  const close = (restoreFocus: boolean) => {
    props.onClose();
    if (restoreFocus) props.state.trigger.focus();
  };
  const run = (action: () => void) => {
    action();
    close(false);
  };

  onMount(() => {
    menuEl.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuEl.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const onScroll = () => close(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onScroll);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onScroll);
    });
  });

  const item =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-semibold text-ink hover:bg-blush-100 focus-visible:bg-blush-100 disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div
      ref={menuEl}
      role="menu"
      aria-label="Move actions"
      class="fixed z-50 w-48 rounded-xl border border-blush-200 bg-white p-1 shadow-card"
      style={{
        left: `${Math.min(props.state.x, window.innerWidth - 200)}px`,
        top: `${Math.min(props.state.y, window.innerHeight - 90)}px`,
      }}
    >
      <button
        type="button"
        role="menuitem"
        class={item}
        disabled={props.mainline}
        onClick={() => run(props.onPromote)}
      >
        <PromoteIcon class="size-4" />
        Make main line
      </button>
      <button
        type="button"
        role="menuitem"
        class={`${item} text-rose-strong`}
        onClick={() => run(props.onDelete)}
      >
        <TrashIcon class="size-4" />
        Delete from here
      </button>
    </div>
  );
}
