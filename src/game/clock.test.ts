import { describe, expect, test } from "vitest";
import { formatClock, halt, newClock, press, remaining, start, timeControlLabel } from "./clock";

describe("chess clock", () => {
  const control = { initialMs: 60_000, incrementMs: 2000 };

  test("runs only for the side to move and adds the increment after each move", () => {
    let clock = start(newClock(control), "w", 1000);
    expect(remaining(clock, "w", 4000)).toBe(57_000);
    expect(remaining(clock, "b", 4000)).toBe(60_000);

    clock = press(clock, "w", 4000, control.incrementMs);
    expect(clock.running).toBe("b");
    expect(remaining(clock, "w", 9000)).toBe(59_000);
    expect(remaining(clock, "b", 9000)).toBe(55_000);
  });

  test("stops when halted and never goes below zero", () => {
    let clock = start(newClock(control), "b", 0);
    clock = halt(clock, 10_000);
    expect(clock.running).toBeUndefined();
    expect(remaining(clock, "b", 50_000)).toBe(50_000);
    expect(remaining(start(clock, "b", 0), "b", 120_000)).toBe(0);
  });
});

describe("clock labels", () => {
  test("show tenths only when time is short", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(305_400)).toBe("5:05");
    expect(formatClock(10_000)).toBe("0:10");
    expect(formatClock(9_960)).toBe("9.9");
    expect(formatClock(0)).toBe("0.0");
  });

  test("name time controls", () => {
    expect(timeControlLabel(undefined)).toBe("Untimed");
    expect(timeControlLabel({ initialMs: 300_000, incrementMs: 3000 })).toBe("5+3");
    expect(timeControlLabel({ initialMs: 30_000, incrementMs: 0 })).toBe("½+0");
  });
});
