import { describe, expect, it } from "vitest";
import { START_FEN } from "./board";
import { completeFen, formatResult, looksLikeFen } from "./database";

describe("looksLikeFen", () => {
  it("accepts full FENs and bare piece placements", () => {
    expect(looksLikeFen(START_FEN)).toBe(true);
    expect(looksLikeFen("  r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R  ")).toBe(true);
    expect(looksLikeFen("8/8/8/8/8/8/8/8 w - - 0 1")).toBe(true);
  });

  it("rejects names and broken placements", () => {
    expect(looksLikeFen("Carlsen")).toBe(false);
    expect(looksLikeFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP")).toBe(false);
    expect(looksLikeFen("rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w")).toBe(false);
    expect(looksLikeFen("rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w")).toBe(false);
    expect(looksLikeFen("rnbqkbnr/pppxpppp/8/8/8/8/PPPPPPPP/RNBQKBNR w")).toBe(false);
  });
});

describe("completeFen", () => {
  it("fills in missing fields", () => {
    expect(completeFen("8/8/8/8/8/8/8/K6k")).toBe("8/8/8/8/8/8/8/K6k w - - 0 1");
    expect(completeFen("8/8/8/8/8/8/8/K6k b")).toBe("8/8/8/8/8/8/8/K6k b - - 0 1");
    expect(completeFen(START_FEN)).toBe(START_FEN);
  });
});

it("writes draws as ½-½", () => {
  expect(formatResult("1/2-1/2")).toBe("½-½");
  expect(formatResult("1-0")).toBe("1-0");
});
