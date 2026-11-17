import type { JSX } from "solid-js";

type IconProps = { class?: string };

function Stroke(props: IconProps & { children: JSX.Element }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={props.class ?? "size-5"}
    >
      {props.children}
    </svg>
  );
}

export const BoardIcon = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M12 4v16M4 12h16" />
  </Stroke>
);

export const DatabaseIcon = (p: IconProps) => (
  <Stroke {...p}>
    <ellipse cx="12" cy="6" rx="7" ry="2.5" />
    <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
    <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
  </Stroke>
);

export const EngineIcon = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </Stroke>
);

export const PuzzleIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M5 8h3.5a2 2 0 1 1 4 0H16v3.5a2 2 0 1 1 0 4V19H5z" />
  </Stroke>
);

export const FolderIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H10l2 2h6.5A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
  </Stroke>
);

export const SunIcon = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </Stroke>
);

export const SearchIcon = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.5-4.5" />
  </Stroke>
);

export const PlusIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 5v14M5 12h14" />
  </Stroke>
);

export const CloseIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M7 7l10 10M17 7 7 17" />
  </Stroke>
);

export const FlipIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4" />
  </Stroke>
);

export const SoundOnIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Stroke>
);

export const SoundOffIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5z" />
    <path d="M16 10l4 4M20 10l-4 4" />
  </Stroke>
);

export const PencilIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M15 5l4 4L8 20H4v-4z" />
    <path d="M13 7l4 4" />
  </Stroke>
);

export const CopyIcon = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </Stroke>
);

export const CheckIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Stroke>
);

export const FirstIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M7 6v12M17 6l-6 6 6 6" />
  </Stroke>
);

export const PrevIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="m15 6-6 6 6 6" />
  </Stroke>
);

export const NextIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="m9 6 6 6-6 6" />
  </Stroke>
);

export const LastIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M17 6v12M7 6l6 6-6 6" />
  </Stroke>
);

export const ChartIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 20h16M7 16v-4M11 16V8M15 16v-6M19 16V5" />
  </Stroke>
);

export const ImportIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M5 15v2a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2" />
  </Stroke>
);

export const ExportIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M5 15v2a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2" />
  </Stroke>
);

export const PromoteIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" />
  </Stroke>
);

export const TrashIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12" />
  </Stroke>
);

export const FileIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5z" />
    <path d="M13.5 3.5V8H18" />
  </Stroke>
);

export const UpIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Stroke>
);

export const ClockIcon = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 2" />
  </Stroke>
);

export const BulbIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M9 17.5h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
  </Stroke>
);

export const FlameIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 21a6 6 0 0 0 6-6c0-3.5-2.5-5.5-3.5-8.5-1.5 1.5-2 3-2 4.5-1-1-1.5-2.5-1.5-4C8 9 6 11.5 6 15a6 6 0 0 0 6 6z" />
  </Stroke>
);

export const ExternalIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </Stroke>
);

export const DownloadIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M5 15v2a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2" />
  </Stroke>
);

export const RetryIcon = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
    <path d="M4.5 4.5V9H9" />
  </Stroke>
);

/** A two-faced chess clock, for playing against the engine. */
export const ChessClockIcon = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="8" width="18" height="12" rx="3" />
    <circle cx="8.5" cy="14" r="2.6" />
    <circle cx="15.5" cy="14" r="2.6" />
    <path d="M8.5 14v-1.4M15.5 14l1-1M8.5 8V5.5M7 5.5h3M15.5 8V6.5" />
  </Stroke>
);

/** Rounded cat head used for the logo and the coach avatar. */
export function CatIcon(props: IconProps & { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" class={props.class ?? "size-5"}>
      <path
        d="M4.5 3.5 9 7.2a9 9 0 0 1 6 0l4.5-3.7c.6 2.4.6 5 .2 7.3A8 8 0 0 1 12 21a8 8 0 0 1-7.7-10.2c-.4-2.3-.4-4.9.2-7.3z"
        fill={props.filled ? "currentColor" : "none"}
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
      />
      <g fill={props.filled ? "var(--color-blush-50)" : "currentColor"}>
        <circle cx="9" cy="12.5" r="1.1" />
        <circle cx="15" cy="12.5" r="1.1" />
      </g>
      <path
        d="M10.8 15.4 12 16.4l1.2-1"
        fill="none"
        stroke={props.filled ? "var(--color-blush-50)" : "currentColor"}
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function PawIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class={props.class ?? "size-5"}>
      <ellipse cx="12" cy="15.5" rx="4.6" ry="3.8" />
      <ellipse cx="6" cy="10.5" rx="1.9" ry="2.3" />
      <ellipse cx="9.6" cy="6.8" rx="1.9" ry="2.4" />
      <ellipse cx="14.4" cy="6.8" rx="1.9" ry="2.4" />
      <ellipse cx="18" cy="10.5" rx="1.9" ry="2.3" />
    </svg>
  );
}
