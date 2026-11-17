// The names the user plays under, so the explorer can say how they score and Purrzles can find
// their blunders. Used in the explorer, the Database section and Purrzles.

import { createEffect, createSignal, For, on, Show } from "solid-js";
import { myNames, parseNames, saveMyNames } from "../chess/database";
import { lichessAccount } from "../chess/lichess";
import { INPUT, SECONDARY_BUTTON } from "./ui";

const errorMessage = (error: unknown) => (typeof error === "string" ? error : String(error));

/** A field for the user's names, with players from the database to pick from. */
export function NamesForm(props: {
  /** Called with the saved names. */
  onSaved?: (names: string[]) => void;
  /** Shown above the field. */
  intro?: string;
  class?: string;
}) {
  const [text, setText] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();

  // Start from the saved names once they arrive.
  createEffect(
    on(
      () => myNames()?.names,
      (names) => {
        if (names) setText(names.join(", "));
      },
    ),
  );

  const typed = () => parseNames(text());
  const suggestions = () => {
    const account = lichessAccount();
    const fromLichess = account.status === "signedIn" ? [account.account.username] : [];
    const taken = new Set(typed().map((name) => name.toLowerCase()));
    const seen = new Set<string>();
    return [...fromLichess, ...(myNames()?.suggestions ?? [])].filter((name) => {
      const key = name.toLowerCase();
      if (taken.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const changed = () => typed().join("\n") !== (myNames()?.names ?? []).join("\n");

  const save = async (event?: Event) => {
    event?.preventDefault();
    setSaving(true);
    try {
      const saved = await saveMyNames(typed());
      setText(saved.join(", "));
      setError(undefined);
      props.onSaved?.(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form class={`flex flex-col gap-2 text-left ${props.class ?? ""}`} onSubmit={save}>
      <Show when={props.intro}>
        <p class="text-[13px] leading-snug text-muted">{props.intro}</p>
      </Show>
      <div class="flex gap-2">
        <input
          type="text"
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
          placeholder="Your names, comma-separated"
          aria-label="Your player names"
          spellcheck={false}
          class={`${INPUT} min-w-0 flex-1 text-[13px]`}
        />
        <button type="submit" class={SECONDARY_BUTTON} disabled={saving() || !changed()}>
          Save
        </button>
      </div>
      <Show when={suggestions().length > 0}>
        <div class="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span class="text-muted">Add:</span>
          <For each={suggestions()}>
            {(name) => (
              <button
                type="button"
                class="rounded-full bg-blush-100 px-2.5 py-0.5 font-semibold hover:bg-blush-200"
                onClick={() => setText([...typed(), name].join(", "))}
              >
                {name}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        {(message) => <p class="text-[12px] text-error">Mochi couldn't save them: {message()}</p>}
      </Show>
    </form>
  );
}
