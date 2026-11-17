// The engines the user has set up, shared by every tab. The setup lives in Rust
// (`src-tauri/src/engines.rs`); this keeps the latest copy and wraps its commands.

import { invoke } from "@tauri-apps/api/core";
import { createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

export type UciOption = { name: string } & (
  | { type: "check"; default: boolean }
  | { type: "spin"; default: number; min: number; max: number }
  | { type: "combo"; default: string; choices: string[] }
  | { type: "button" }
  | { type: "string"; default: string }
);

export type EngineEntry = {
  id: string;
  name: string;
  author: string | null;
  /** The engine binary; `null` for the bundled Stockfish. */
  path: string | null;
  /** Options the engine offered when it last started; empty until it has run once. */
  options: UciOption[];
  /** Values the user changed, by option name. */
  values: Record<string, string>;
};

export type EnginesConfig = {
  engines: EngineEntry[];
  /** Analyses the board, drives the eval bar and reviews games. */
  primary: string;
  /** Analyses alongside the primary engine. */
  secondary: string | null;
};

export const BUNDLED_ENGINE = "stockfish";

/** Options EnPawssant sets itself for every search; mirrors `MANAGED_OPTIONS` in Rust. */
export const MANAGED_OPTIONS = new Set(["MultiPV", "UCI_Chess960", "Ponder", "UCI_AnalyseMode"]);

const state = createRoot(() => {
  const [config, setConfig] = createStore<EnginesConfig>({
    engines: [],
    primary: BUNDLED_ENGINE,
    secondary: null,
  });
  const [loaded, setLoaded] = createSignal(false);
  /** Bumped per engine when it restarts with new options, so running searches start again. */
  const [revisions, setRevisions] = createStore<Record<string, number>>({});
  return { config, setConfig, loaded, setLoaded, revisions, setRevisions };
});

/** The current setup; the bundled engine only until `loadEngines` has answered. */
export const enginesConfig = state.config;
export const enginesLoaded = state.loaded;

/** Changes whenever engine `id` restarts with a new setup. */
export const engineRevision = (id: string) => state.revisions[id] ?? 0;

function apply(config: EnginesConfig) {
  state.setConfig(reconcile(config));
  state.setLoaded(true);
}

function restarted(id: string) {
  state.setRevisions(id, (n) => (n ?? 0) + 1);
}

let loading: Promise<void> | undefined;

/** Loads the setup once; later calls share the first one. */
export function loadEngines(): Promise<void> {
  loading ??= invoke<EnginesConfig>("engines_config").then(apply, () => {
    loading = undefined;
  });
  return loading;
}

/** Asks for an engine binary and adds it. Resolves to whether one was added. */
export async function addEngine(): Promise<boolean> {
  const config = await invoke<EnginesConfig | null>("engines_add");
  if (config) apply(config);
  return config !== null;
}

export async function removeEngine(id: string) {
  apply(await invoke<EnginesConfig>("engines_remove", { id }));
  restarted(id);
}

export async function renameEngine(id: string, name: string) {
  apply(await invoke<EnginesConfig>("engines_rename", { id, name }));
}

/** Sets an option, or resets it to the engine's default with `null`. The engine restarts. */
export async function setEngineOption(id: string, name: string, value: string | null) {
  apply(await invoke<EnginesConfig>("engines_set_option", { id, name, value }));
  restarted(id);
}

export async function setEngineRoles(primary: string, secondary: string | null) {
  apply(await invoke<EnginesConfig>("engines_set_roles", { primary, secondary }));
}

/** Starts an engine if needed so its options are known. */
export async function probeEngine(id: string) {
  apply(await invoke<EnginesConfig>("engines_probe", { id }));
}

/** The value an option has: the user's choice, or the engine's default. */
export function optionValue(engine: EngineEntry, option: UciOption): string {
  const chosen = engine.values[option.name];
  if (chosen !== undefined) return chosen;
  return option.type === "button" ? "" : String(option.default);
}
