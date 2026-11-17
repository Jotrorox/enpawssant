// A chess clock as plain data, so it can be tested without timers. Times are in milliseconds and
// `now` comes from the caller (`performance.now()` in the app).

import type { Color } from "../chess/board";

/** Starting time and increment per move. */
export type TimeControl = { initialMs: number; incrementMs: number };

export type ClockState = {
  /** Time left at the moment `since` refers to. */
  white: number;
  black: number;
  /** The side whose time is running, if any. */
  running?: Color;
  /** When `running` last started. */
  since: number;
};

export function newClock(control: TimeControl): ClockState {
  return { white: control.initialMs, black: control.initialMs, since: 0 };
}

/** Time `side` has left at `now`; never below zero. */
export function remaining(clock: ClockState, side: Color, now: number): number {
  const stored = side === "w" ? clock.white : clock.black;
  const elapsed = clock.running === side ? now - clock.since : 0;
  return Math.max(0, stored - elapsed);
}

/** Starts `side`'s time, stopping the other side's without an increment. */
export function start(clock: ClockState, side: Color, now: number): ClockState {
  return { ...halt(clock, now), running: side, since: now };
}

/** Stops the running time. */
export function halt(clock: ClockState, now: number): ClockState {
  return {
    white: remaining(clock, "w", now),
    black: remaining(clock, "b", now),
    since: now,
  };
}

/** `side` finished a move: its time stops, gains the increment, and the other side's starts. */
export function press(
  clock: ClockState,
  side: Color,
  now: number,
  incrementMs: number,
): ClockState {
  const stopped = halt(clock, now);
  const next = side === "w" ? "b" : "w";
  return {
    ...stopped,
    white: stopped.white + (side === "w" ? incrementMs : 0),
    black: stopped.black + (side === "b" ? incrementMs : 0),
    running: next,
    since: now,
  };
}

/**
 * Formats time left as `s.t` under ten seconds, `m:ss`, `h:mm:ss`, or days and hours (`2d 5h`)
 * for correspondence games.
 */
export function formatClock(ms: number): string {
  if (ms < 10_000) return (Math.floor(ms / 100) / 10).toFixed(1);
  if (ms >= 86_400_000) {
    const hours = Math.floor(ms / 3_600_000);
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The PGN `TimeControl` tag, e.g. `300+3`, or `-` without a clock. */
export function pgnTimeControl(control: TimeControl | undefined): string {
  if (!control) return "-";
  return `${Math.round(control.initialMs / 1000)}+${Math.round(control.incrementMs / 1000)}`;
}

/** A short label such as `5+3`, `½+0` or `Untimed`. */
export function timeControlLabel(control: TimeControl | undefined): string {
  if (!control) return "Untimed";
  const minutes = control.initialMs / 60_000;
  const shown = minutes === 0.5 ? "½" : String(Math.round(minutes * 100) / 100);
  return `${shown}+${Math.round(control.incrementMs / 1000)}`;
}
