import { describe, expect, it } from "vitest";
import { SHORTCUTS, shortcutKey } from "./commands";

const press = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;

describe("shortcutKey", () => {
  it("reads Ctrl shortcuts on Windows and Cmd shortcuts on macOS", () => {
    const ctrlS = press({ key: "s", code: "KeyS", ctrlKey: true });
    const cmdS = press({ key: "s", code: "KeyS", metaKey: true });
    expect(shortcutKey(ctrlS, false)).toBe("mod+s");
    expect(shortcutKey(cmdS, false)).toBeUndefined();
    expect(shortcutKey(cmdS, true)).toBe("mod+s");
    expect(shortcutKey(ctrlS, true)).toBeUndefined();
    expect(SHORTCUTS["mod+s"]).toBe("save");
  });

  it("names shifted keys by their unshifted character", () => {
    const next = press({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true });
    expect(shortcutKey(next, false)).toBe("mod+shift+]");
    const save = press({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
    expect(SHORTCUTS[shortcutKey(save, false) ?? ""]).toBe("save-as");
    const board = press({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: false });
    expect(SHORTCUTS[shortcutKey(board, false) ?? ""]).toBe("section:board");
  });

  it("follows the layout for letters", () => {
    // On AZERTY the key labelled A sits where QWERTY has Q.
    expect(shortcutKey(press({ key: "a", code: "KeyQ", ctrlKey: true }), false)).toBe("mod+a");
  });

  it("ignores plain keys and Alt combinations", () => {
    expect(shortcutKey(press({ key: "f", code: "KeyF" }), false)).toBeUndefined();
    expect(
      shortcutKey(press({ key: "n", code: "KeyN", ctrlKey: true, altKey: true }), false),
    ).toBeUndefined();
    expect(shortcutKey(press({ key: "Tab", code: "Tab", ctrlKey: true }), false)).toBe("ctrl+tab");
  });
});
