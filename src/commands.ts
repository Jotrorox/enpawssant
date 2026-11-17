// App commands such as "save" or "flip the board". On macOS they come from the native menu (see
// `src-tauri/src/menu.rs`), which owns the keyboard shortcuts there; elsewhere the same shortcuts
// are read from key presses here. Either way they reach whoever subscribed with `onCommand`.

import { listen } from "@tauri-apps/api/event";
import { onCleanup } from "solid-js";
import type { Section } from "./components/SideRail";

export type Command =
  | "new-tab"
  | "open"
  | "import"
  | "save"
  | "save-as"
  | "export"
  | "save-to-database"
  | "close-tab"
  | "copy-fen"
  | "flip"
  | "edit-position"
  | "toggle-engine"
  | "analyze-game"
  | "play"
  | "search"
  | "settings"
  | "check-updates"
  | "prev-tab"
  | "next-tab"
  | "recent-clear"
  | `section:${Section}`
  /** Opens the recent file at this index; see `menu_set_recent`. */
  | `recent:${number}`;

export const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** Shortcuts as `mod+shift+key`, where `mod` is Cmd on macOS and Ctrl elsewhere. */
export const SHORTCUTS: Readonly<Record<string, Command>> = {
  "mod+n": "new-tab",
  "mod+o": "open",
  "mod+shift+o": "import",
  "mod+s": "save",
  "mod+shift+s": "save-as",
  "mod+shift+e": "export",
  "mod+d": "save-to-database",
  "mod+w": "close-tab",
  "mod+shift+c": "copy-fen",
  "mod+shift+f": "flip",
  "mod+e": "edit-position",
  "mod+l": "toggle-engine",
  "mod+shift+l": "analyze-game",
  "mod+1": "section:board",
  "mod+2": "section:play",
  "mod+3": "section:database",
  "mod+4": "section:engines",
  "mod+5": "section:puzzles",
  "mod+6": "section:files",
  "mod+k": "search",
  "mod+,": "settings",
  "mod+shift+[": "prev-tab",
  "mod+shift+]": "next-tab",
  "ctrl+tab": "next-tab",
  "ctrl+shift+tab": "prev-tab",
};

/** Physical keys whose character changes with Shift, by `KeyboardEvent.code`. */
const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Tab: "tab",
};

/** The shortcut a key press stands for, as a key into `SHORTCUTS`. */
export function shortcutKey(event: KeyboardEvent, mac = isMac): string | undefined {
  let key: string | undefined;
  if (event.code in CODE_KEYS) key = CODE_KEYS[event.code];
  else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  else if (/^[a-z]$/i.test(event.key)) key = event.key.toLowerCase();
  if (!key) return undefined;
  const shift = event.shiftKey ? "shift+" : "";
  if (key === "tab") return event.ctrlKey && !event.metaKey ? `ctrl+${shift}tab` : undefined;
  const [mod, other] = mac ? [event.metaKey, event.ctrlKey] : [event.ctrlKey, event.metaKey];
  if (!mod || other || event.altKey) return undefined;
  return `mod+${shift}${key}`;
}

type Handler = (command: Command) => void;
const handlers = new Set<Handler>();

/**
 * Runs `command`, e.g. from a button that does the same as a menu item. Nothing happens while a
 * dialog is open, so shortcuts never act on a board hidden behind it.
 */
export function runCommand(command: Command) {
  if (typeof document !== "undefined" && document.querySelector("dialog[open]")) return;
  for (const handler of handlers) handler(command);
}

/** Calls `handler` for every command until the calling component is cleaned up. */
export function onCommand(handler: Handler) {
  handlers.add(handler);
  onCleanup(() => handlers.delete(handler));
}

/** Starts forwarding menu choices and (outside macOS) keyboard shortcuts as commands. */
export function startCommands(): () => void {
  const cleanups: (() => void)[] = [];
  listen<string>("menu", (event) => runCommand(event.payload as Command)).then(
    (unlisten) => cleanups.push(unlisten),
    () => {
      // Outside Tauri there is no menu.
    },
  );
  if (!isMac) {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = shortcutKey(event);
      const command = key ? SHORTCUTS[key] : undefined;
      if (!command) return;
      event.preventDefault();
      runCommand(command);
    };
    window.addEventListener("keydown", onKeyDown);
    cleanups.push(() => window.removeEventListener("keydown", onKeyDown));
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
