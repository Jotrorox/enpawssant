import { For, type JSX, Show } from "solid-js";
import { toggleTheme } from "../appearance";
import { resolvedTheme } from "../settings";
import {
  BoardIcon,
  ChessClockIcon,
  DatabaseIcon,
  EngineIcon,
  FolderIcon,
  GearIcon,
  MoonIcon,
  PuzzleIcon,
  SunIcon,
} from "./Icons";

export type Section = "board" | "play" | "database" | "engines" | "puzzles" | "files";

const SECTIONS: { id: Section; label: string; icon: () => JSX.Element }[] = [
  { id: "board", label: "Board", icon: () => <BoardIcon class="size-[22px]" /> },
  { id: "play", label: "Play", icon: () => <ChessClockIcon class="size-[22px]" /> },
  { id: "database", label: "Database", icon: () => <DatabaseIcon class="size-[22px]" /> },
  { id: "engines", label: "Engines", icon: () => <EngineIcon class="size-[22px]" /> },
  { id: "puzzles", label: "Purrzles", icon: () => <PuzzleIcon class="size-[22px]" /> },
  { id: "files", label: "Files", icon: () => <FolderIcon class="size-[22px]" /> },
];

export function SideRail(props: {
  active: Section;
  onSelect: (section: Section) => void;
  onSettings: () => void;
  /** Things waiting in a section, such as challenges and games where it's the user's turn. */
  badges?: Partial<Record<Section, number>>;
}) {
  const active = () => props.active;

  return (
    <nav
      aria-label="Sections"
      class="flex w-[61px] shrink-0 flex-col items-center gap-2 border-r border-blush-200 bg-blush-50 py-3.5"
    >
      <For each={SECTIONS}>
        {(section) => (
          <button
            type="button"
            title={section.label}
            aria-label={section.label}
            aria-current={active() === section.id ? "page" : undefined}
            onClick={() => props.onSelect(section.id)}
            class={`relative grid size-[44px] place-items-center rounded-2xl transition-colors ${
              active() === section.id
                ? "bg-raised text-rose shadow-[0_2px_8px_rgb(224_112_143/0.25)]"
                : "text-ink/80 hover:bg-blush-100 hover:text-ink"
            }`}
          >
            {section.icon()}
            <Show when={props.badges?.[section.id]}>
              {(count) => (
                <span class="absolute -top-0.5 -right-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-rose px-1 text-[11px] leading-none font-bold text-snow">
                  {count()}
                </span>
              )}
            </Show>
          </button>
        )}
      </For>
      <ThemeToggle />
      <button
        type="button"
        title="Settings"
        aria-label="Settings"
        onClick={() => props.onSettings()}
        class="grid size-[44px] place-items-center rounded-2xl text-ink/80 hover:bg-blush-100 hover:text-ink"
      >
        <GearIcon class="size-[22px]" />
      </button>
    </nav>
  );
}

/** Flips between the light and dark theme; the moon shows by day and the sun by night. */
function ThemeToggle() {
  const dark = () => resolvedTheme() === "dark";
  const label = () => (dark() ? "Switch to light theme" : "Switch to dark theme");
  const icon = "theme-toggle-icon absolute size-[22px]";

  return (
    <button
      type="button"
      title={label()}
      aria-label={label()}
      onClick={(event) => toggleTheme(event.currentTarget)}
      class="relative mt-auto grid size-[44px] place-items-center overflow-hidden rounded-2xl text-ink/80 transition-colors hover:bg-blush-100 hover:text-ink dark:text-cream/90 dark:hover:text-cream"
    >
      <MoonIcon
        class={`${icon} ${dark() ? "translate-y-6 -rotate-90 opacity-0" : "rotate-0 opacity-100"}`}
      />
      <SunIcon
        class={`${icon} ${dark() ? "rotate-0 opacity-100" : "-translate-y-6 rotate-90 opacity-0"}`}
      />
    </button>
  );
}
