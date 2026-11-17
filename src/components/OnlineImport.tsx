// The Lichess and Chess.com tabs of the import dialog: a player's latest games, or the games they
// played between two dates. The dialog mounts a new form for each site.

import { createEffect, createSignal, on, onCleanup, Show, untrack } from "solid-js";
import { lichessAccount } from "../chess/lichess";
import {
  dateRange,
  fetchOnlineGames,
  type GameFilter,
  isoDay,
  MAX_ONLINE_GAMES,
  type OnlineSite,
  rememberedUsername,
  rememberUsername,
  SITE_NAMES,
} from "../chess/online";
import type { ParsedPgn } from "../chess/pgn";
import { DownloadIcon } from "./Icons";
import { INPUT, PRIMARY_BUTTON, ProgressBar, Segmented } from "./ui";

type Mode = "latest" | "dates";

const MODES = [
  { value: "latest", label: "Latest games" },
  { value: "dates", label: "Between dates" },
] as const;

const DEFAULT_COUNT = 20;
/** Date ranges start this many days back. */
const DEFAULT_DAYS = 30;

export type FetchedGames = ParsedPgn & { site: OnlineSite; username: string };

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

export function OnlineImport(props: {
  site: OnlineSite;
  onFetched: (games: FetchedGames) => void;
}) {
  const signedInAs = () => {
    const state = lichessAccount();
    return props.site === "lichess" && state.status === "signedIn"
      ? state.account.username
      : undefined;
  };
  // Each site starts with the name last used there, or else the signed-in Lichess account.
  const [username, setUsername] = createSignal(
    rememberedUsername(props.site) || (signedInAs() ?? ""),
  );
  const [mode, setMode] = createSignal<Mode>("latest");
  const [count, setCount] = createSignal(DEFAULT_COUNT);
  const today = isoDay(new Date());
  const [from, setFrom] = createSignal(
    isoDay(new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000)),
  );
  const [to, setTo] = createSignal(today);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  // The account may only be known after the dialog opened. Only the account is tracked, so
  // clearing the field leaves it empty.
  createEffect(
    on(signedInAs, (account) => {
      if (account && untrack(username) === "") setUsername(account);
    }),
  );

  // A fetch that finishes after the dialog closed or switched tabs is dropped.
  let attempt = 0;
  onCleanup(() => attempt++);

  const filter = (): GameFilter =>
    mode() === "latest" ? { kind: "latest", count: count() } : dateRange(from(), to());
  const datesValid = () => !from() || !to() || from() <= to();
  const canFetch = () =>
    !busy() && username().trim() !== "" && (mode() === "latest" || datesValid());

  const fetchGames = async () => {
    if (!canFetch()) return;
    const site = props.site;
    const name = username().trim();
    const current = ++attempt;
    setBusy(true);
    setError(undefined);
    try {
      const parsed = await fetchOnlineGames(site, name, filter());
      if (current !== attempt) return;
      rememberUsername(site, name);
      if (parsed.games.length === 0) {
        setError(
          parsed.errors[0] ??
            (mode() === "latest"
              ? `${name} has no finished games of standard chess on ${SITE_NAMES[site]}.`
              : `${name} played no games of standard chess on ${SITE_NAMES[site]} in those days.`),
        );
        return;
      }
      props.onFetched({ ...parsed, site, username: name });
    } catch (e) {
      if (current === attempt) setError(errorMessage(e));
    } finally {
      if (current === attempt) setBusy(false);
    }
  };

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void fetchGames();
      }}
    >
      <label class="flex flex-col gap-1.5">
        <span class="text-[11px] font-bold tracking-[0.08em] text-ink/70 uppercase">
          {SITE_NAMES[props.site]} username
        </span>
        <div class="flex items-center gap-2">
          <input
            value={username()}
            onInput={(event) => setUsername(event.currentTarget.value)}
            placeholder={props.site === "lichess" ? "e.g. MochiTheCat" : "e.g. whiskers"}
            autocomplete="off"
            spellcheck={false}
            class={`${INPUT} flex-1`}
          />
          <Show when={signedInAs() && signedInAs() !== username().trim() && signedInAs()}>
            {(account) => (
              <button
                type="button"
                class="text-[13px] font-semibold text-muted underline-offset-2 hover:text-ink hover:underline"
                onClick={() => setUsername(account())}
              >
                Use {account()}
              </button>
            )}
          </Show>
        </div>
      </label>

      <div class="flex flex-col gap-2">
        <Segmented label="Which games" options={MODES} value={mode()} onChange={setMode} />
        <Show
          when={mode() === "latest"}
          fallback={
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] font-semibold">
              <label class="flex items-center gap-2">
                From
                <input
                  type="date"
                  value={from()}
                  max={to() || today}
                  onInput={(event) => setFrom(event.currentTarget.value)}
                  class={INPUT}
                />
              </label>
              <label class="flex items-center gap-2">
                to
                <input
                  type="date"
                  value={to()}
                  min={from()}
                  max={today}
                  onInput={(event) => setTo(event.currentTarget.value)}
                  class={INPUT}
                />
              </label>
            </div>
          }
        >
          <label class="flex items-center gap-2 text-[13px] font-semibold">
            The last
            <input
              type="number"
              min={1}
              max={MAX_ONLINE_GAMES}
              value={count()}
              onChange={(event) => {
                const value = Math.round(Number(event.currentTarget.value));
                const valid = Number.isFinite(value)
                  ? Math.min(MAX_ONLINE_GAMES, Math.max(1, value))
                  : DEFAULT_COUNT;
                event.currentTarget.value = String(valid);
                setCount(valid);
              }}
              class={`${INPUT} w-[84px] font-mono`}
            />
            games
          </label>
        </Show>
      </div>

      <p class="text-[12px] text-muted">
        Standard chess only, up to {MAX_ONLINE_GAMES} games at a time.{" "}
        {props.site === "lichess"
          ? "Games analysed on Lichess bring their evaluations along."
          : "Chess.com shares public games without an account."}
      </p>

      <Show when={!datesValid() && mode() === "dates"}>
        <p role="alert" class="text-[13px] font-semibold text-error">
          The first day comes after the last one.
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="text-[13px] font-semibold text-error">
          {error()}
        </p>
      </Show>

      <div class="flex items-center gap-3">
        <Show when={busy()}>
          <ProgressBar label={`Fetching games from ${SITE_NAMES[props.site]}`} class="flex-1" />
        </Show>
        <button type="submit" class={`${PRIMARY_BUTTON} ml-auto`} disabled={!canFetch()}>
          <DownloadIcon class="size-[18px]" />
          {busy() ? "Fetching games…" : "Fetch games"}
        </button>
      </div>
    </form>
  );
}
