import { For, type JSX } from "solid-js";
import { BoardIcon, DatabaseIcon, EngineIcon, FolderIcon, GearIcon, PuzzleIcon } from "./Icons";

export type Section = "board" | "database" | "engines" | "puzzles" | "files";

const SECTIONS: { id: Section; label: string; icon: () => JSX.Element }[] = [
  { id: "board", label: "Board", icon: () => <BoardIcon class="size-[22px]" /> },
  { id: "database", label: "Database", icon: () => <DatabaseIcon class="size-[22px]" /> },
  { id: "engines", label: "Engines", icon: () => <EngineIcon class="size-[22px]" /> },
  { id: "puzzles", label: "Purrzles", icon: () => <PuzzleIcon class="size-[22px]" /> },
  { id: "files", label: "Files", icon: () => <FolderIcon class="size-[22px]" /> },
];

export function SideRail(props: {
  active: Section;
  onSelect: (section: Section) => void;
  onSettings: () => void;
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
            class={`grid size-[44px] place-items-center rounded-2xl transition-colors ${
              active() === section.id
                ? "bg-white text-rose shadow-[0_2px_8px_rgb(224_112_143/0.25)]"
                : "text-ink/80 hover:bg-blush-100 hover:text-ink"
            }`}
          >
            {section.icon()}
          </button>
        )}
      </For>
      <button
        type="button"
        title="Settings"
        aria-label="Settings"
        onClick={() => props.onSettings()}
        class="mt-auto grid size-[44px] place-items-center rounded-2xl text-ink/80 hover:bg-blush-100 hover:text-ink"
      >
        <GearIcon class="size-[22px]" />
      </button>
    </nav>
  );
}
