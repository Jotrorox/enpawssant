import { For, onCleanup, onMount } from "solid-js";
import { CatIcon, CloseIcon, PlusIcon, SearchIcon } from "./Icons";

export type WorkspaceTab = { id: string; title: string; live?: boolean };

const isMac = navigator.userAgent.includes("Mac");

type TitleBarProps = {
  tabs: WorkspaceTab[];
  activeId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
};

export function TitleBar(props: TitleBarProps) {
  let search: HTMLInputElement | undefined;

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        search?.focus();
        search?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <header
      data-tauri-drag-region
      class={`flex h-11 shrink-0 items-end gap-2 bg-blush-200/80 pr-3 ${isMac ? "pl-[84px]" : "pl-4"}`}
    >
      <div data-tauri-drag-region class="mr-5 flex h-full items-center gap-2">
        <CatIcon filled class="pointer-events-none size-[18px] text-rose" />
        <span class="pointer-events-none font-display text-[15px] font-semibold text-ink">
          EnPawssant
        </span>
      </div>

      <nav aria-label="Open tabs" class="flex h-full min-w-0 items-end gap-1">
        <For each={props.tabs}>
          {(tab) => {
            const active = () => tab.id === props.activeId;
            return (
              <div
                class={`group flex h-[34px] min-w-0 items-center gap-2 rounded-t-xl pr-2 pl-4 text-[13px] font-bold transition-colors ${
                  active() ? "bg-blush-50 text-ink" : "text-ink/80 hover:bg-blush-100/60"
                }`}
              >
                <button
                  type="button"
                  onClick={() => props.onSelect(tab.id)}
                  aria-current={active() ? "page" : undefined}
                  class="flex min-w-0 items-center gap-2"
                >
                  {tab.live && <span class="size-2 shrink-0 rounded-full bg-rose" />}
                  <span class="truncate">{tab.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => props.onClose(tab.id)}
                  class={`grid size-5 place-items-center rounded-md text-ink/60 hover:bg-blush-200 hover:text-ink ${
                    active() ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  }`}
                >
                  <CloseIcon class="size-3.5" />
                </button>
              </div>
            );
          }}
        </For>
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={() => props.onNew()}
          class="mb-1 grid size-7 place-items-center rounded-lg text-ink/70 hover:bg-blush-100/70 hover:text-ink"
        >
          <PlusIcon class="size-4" />
        </button>
      </nav>

      <div data-tauri-drag-region class="h-full flex-1" />

      <label class="mb-[5px] flex h-[30px] w-[264px] shrink-0 items-center gap-2 rounded-full bg-blush-50 px-3 text-[13px] ring-1 ring-blush-200 focus-within:ring-rose">
        <SearchIcon class="size-4 shrink-0 text-ink/70" />
        <input
          ref={search}
          type="search"
          placeholder="Search games, players, FEN…"
          aria-label="Search games, players, FEN"
          class="min-w-0 flex-1 bg-transparent font-semibold text-ink outline-none placeholder:text-ink/80"
        />
        <kbd class="shrink-0 font-body text-[11px] font-bold text-ink/60">
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      </label>
    </header>
  );
}
