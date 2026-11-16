import { invoke } from "@tauri-apps/api/core";
import { createResource, Match, Switch } from "solid-js";

const fetchEngineInfo = () => invoke<string>("engine_info");

export default function App() {
  const [engine] = createResource(fetchEngineInfo);

  return (
    <>
      {/* Lets the window be dragged where the macOS overlay title bar used to be. */}
      <div class="titlebar" data-tauri-drag-region />
      <main class="app">
        <h1 class="wordmark">EnPawssant</h1>
        <p class="engine" aria-live="polite">
          <Switch>
            <Match when={engine.error}>
              <span class="engine-error">Engine unavailable: {String(engine.error)}</span>
            </Match>
            <Match when={engine.loading}>Waking up the engine…</Match>
            <Match when={engine()}>
              {(name) => (
                <>
                  Engine: <code>{name()}</code>
                </>
              )}
            </Match>
          </Switch>
        </p>
      </main>
    </>
  );
}
