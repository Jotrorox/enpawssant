import { describe, expect, test } from "vitest";
import { sampleGame } from "../data/mockGame";
import { parseWorkspace, type SavedWorkspace, serializeWorkspace } from "./workspace";

const tab = (title: string) => ({ title, game: sampleGame, position: [0, 0, 1] });

describe("saved workspace", () => {
  test("survives a round trip", () => {
    const workspace: SavedWorkspace = { tabs: [tab("One"), tab("Two")], active: 1 };
    expect(parseWorkspace(serializeWorkspace(workspace))).toEqual(workspace);
  });

  test("keeps the board orientation and the file a tab was saved to", () => {
    const workspace: SavedWorkspace = {
      tabs: [{ ...tab("Flipped"), orientation: "b", path: "/games/flipped.pgn" }, tab("Plain")],
      active: 0,
    };
    expect(parseWorkspace(serializeWorkspace(workspace))).toEqual(workspace);
    const odd = JSON.stringify({
      version: 1,
      tabs: [{ ...tab("Odd"), orientation: "x" }],
      active: 0,
    });
    expect(parseWorkspace(odd)?.tabs).toEqual([]);
  });

  test("ignores data it can't read", () => {
    expect(parseWorkspace("not json")).toBeUndefined();
    expect(parseWorkspace("[]")).toBeUndefined();
    expect(parseWorkspace(JSON.stringify({ version: 0, tabs: [], active: 0 }))).toBeUndefined();
  });

  test("drops broken tabs and keeps the active one selected", () => {
    const text = JSON.stringify({
      version: 1,
      tabs: [{ title: "Broken", game: { moves: [] }, position: [] }, tab("One"), tab("Two")],
      active: 2,
    });
    expect(parseWorkspace(text)).toEqual({ tabs: [tab("One"), tab("Two")], active: 1 });
  });

  test("falls back to the first tab when the active one is gone", () => {
    const text = JSON.stringify({ version: 1, tabs: [tab("One"), "junk"], active: 1 });
    expect(parseWorkspace(text)).toEqual({ tabs: [tab("One")], active: 0 });
  });
});
