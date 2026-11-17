import { describe, expect, it } from "vitest";
import {
  formatComment,
  parseComment,
  toggleShape,
  withCommentText,
  withShapes,
} from "./annotations";

describe("parseComment", () => {
  it("splits text, shapes and other commands", () => {
    const parts = parseComment(
      "[%clk 0:03:00] Good  idea [%csl Gd4,Rf7][%cal Ge2e4,Bd7d5] here [%emt 0:00:05]",
    );
    expect(parts.text).toBe("Good idea here");
    expect(parts.commands).toEqual(["[%clk 0:03:00]", "[%emt 0:00:05]"]);
    expect(parts.shapes).toEqual([
      { from: "d4", to: "d4", color: "green" },
      { from: "f7", to: "f7", color: "red" },
      { from: "e2", to: "e4", color: "green" },
      { from: "d7", to: "d5", color: "blue" },
    ]);
  });

  it("skips malformed and repeated shapes", () => {
    const parts = parseComment("[%cal Ge2e4, Xa1a2, Ge2e4, Rh9h1] [%csl Gd4d5]");
    expect(parts.shapes).toEqual([{ from: "e2", to: "e4", color: "green" }]);
    expect(parts.text).toBe("");
  });

  it("handles a missing comment", () => {
    expect(parseComment(undefined)).toEqual({ text: "", shapes: [], commands: [] });
  });
});

describe("formatComment", () => {
  it("writes commands, circles, arrows, then the text", () => {
    expect(
      formatComment({
        text: " Watch f7. ",
        commands: ["[%clk 0:01:00]"],
        shapes: [
          { from: "c4", to: "f7", color: "red" },
          { from: "f7", to: "f7", color: "yellow" },
        ],
      }),
    ).toBe("[%clk 0:01:00] [%csl Yf7] [%cal Rc4f7] Watch f7.");
  });

  it("returns undefined for an empty comment", () => {
    expect(formatComment({ text: "  ", shapes: [], commands: [] })).toBeUndefined();
  });

  it("round-trips through parseComment", () => {
    const comment = "[%csl Gd4] [%cal Ge2e4,Yb1c3] A plan.";
    expect(formatComment(parseComment(comment))).toBe(comment);
  });
});

describe("editing", () => {
  it("replaces the text and keeps the shapes", () => {
    expect(withCommentText("[%cal Ge2e4] old", "new words")).toBe("[%cal Ge2e4] new words");
    expect(withCommentText("[%cal Ge2e4] old", "")).toBe("[%cal Ge2e4]");
    expect(withCommentText("only text", "")).toBeUndefined();
  });

  it("replaces the shapes and keeps the text", () => {
    expect(
      withShapes("[%clk 0:00:09] Nice [%csl Ra1]", [{ from: "h1", to: "h8", color: "blue" }]),
    ).toBe("[%clk 0:00:09] [%cal Bh1h8] Nice");
    expect(withShapes("[%csl Ra1]", [])).toBeUndefined();
  });

  it("toggles shapes like lichess", () => {
    const arrow = { from: "e2", to: "e4", color: "green" } as const;
    expect(toggleShape([], arrow)).toEqual([arrow]);
    expect(toggleShape([arrow], arrow)).toEqual([]);
    // The same arrow in another colour replaces it.
    expect(toggleShape([arrow], { ...arrow, color: "red" })).toEqual([{ ...arrow, color: "red" }]);
  });
});
