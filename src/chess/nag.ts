// Numeric annotation glyphs (NAGs) as PGN stores them, and the symbols the notation shows.

import type { Color } from "./board";

/** Move-quality annotations, which a move has at most one of. */
export type Nag = "!!" | "!" | "!?" | "?!" | "?" | "??";

/** The annotations offered in the notation toolbar, best to worst. */
export const NAGS: readonly Nag[] = ["!!", "!", "!?", "?!", "?"];

/** Every move-quality annotation, best to worst, for the annotation editor. */
export const ALL_NAGS: readonly Nag[] = ["!!", "!", "!?", "?!", "?", "??"];

export const NAG_CODES: Record<Nag, number> = {
  "!": 1,
  "?": 2,
  "!!": 3,
  "??": 4,
  "!?": 5,
  "?!": 6,
};

const QUALITY_BY_CODE = new Map(Object.entries(NAG_CODES).map(([nag, code]) => [code, nag as Nag]));

/** An annotation the editor offers. `black` is the code used after Black's moves, if it differs. */
export type NagChoice = { code: number; black?: number; symbol: string; label: string };

/** Assessments of the position after the move; a move has at most one. */
export const POSITION_NAGS: readonly NagChoice[] = [
  { code: 10, symbol: "=", label: "Equal position" },
  { code: 13, symbol: "∞", label: "Unclear position" },
  { code: 14, symbol: "⩲", label: "White is slightly better" },
  { code: 15, symbol: "⩱", label: "Black is slightly better" },
  { code: 16, symbol: "±", label: "White is better" },
  { code: 17, symbol: "∓", label: "Black is better" },
  { code: 18, symbol: "+−", label: "White is winning" },
  { code: 19, symbol: "−+", label: "Black is winning" },
];

/** Remarks about the move or the position, which can be combined. */
export const OBSERVATION_NAGS: readonly NagChoice[] = [
  { code: 7, symbol: "□", label: "Only move" },
  { code: 146, symbol: "N", label: "Novelty" },
  { code: 32, black: 33, symbol: "⟳", label: "Development advantage" },
  { code: 36, black: 37, symbol: "↑", label: "Initiative" },
  { code: 40, black: 41, symbol: "→", label: "Attack" },
  { code: 132, black: 133, symbol: "⇆", label: "Counterplay" },
  { code: 44, black: 45, symbol: "=∞", label: "With compensation" },
  { code: 140, symbol: "∆", label: "With the idea" },
  { code: 22, black: 23, symbol: "⨀", label: "Zugzwang" },
  { code: 138, black: 139, symbol: "⊕", label: "Time trouble" },
];

/** Codes 10 to 19 all assess the position, including the rarely used 11 and 12. */
const isPositionCode = (code: number) => code >= 10 && code <= 19;

/** Symbols for the annotations other than move quality, e.g. `±`. */
const SYMBOLS: Record<number, string> = Object.fromEntries([
  [11, "="],
  [12, "="],
  ...[...POSITION_NAGS, ...OBSERVATION_NAGS].flatMap((choice) => [
    [choice.code, choice.symbol],
    ...(choice.black ? [[choice.black, choice.symbol]] : []),
  ]),
]);

/** The move-quality annotation among `nags`, if any. */
export function qualityNag(nags: readonly number[]): Nag | undefined {
  for (const code of nags) {
    const nag = QUALITY_BY_CODE.get(code);
    if (nag) return nag;
  }
  return undefined;
}

/** Symbols for the annotations other than move quality, e.g. `±`. Unknown codes are left out. */
export function otherNagSymbols(nags: readonly number[]): string {
  return sortNags(nags)
    .filter((code) => !QUALITY_BY_CODE.has(code))
    .map((code) => SYMBOLS[code] ?? "")
    .join("");
}

/** Move quality first, then the position assessment, then everything else in its old order. */
function sortNags(nags: readonly number[]): number[] {
  const rank = (code: number) => (QUALITY_BY_CODE.has(code) ? 0 : isPositionCode(code) ? 1 : 2);
  return [...nags].sort((a, b) => rank(a) - rank(b));
}

/** `nags` with the move-quality annotation set to `nag`, or cleared if it already was `nag`. */
export function toggleQualityNag(nags: readonly number[], nag: Nag): number[] {
  const code = NAG_CODES[nag];
  const others = nags.filter((n) => !QUALITY_BY_CODE.has(n));
  return nags.includes(code) ? others : sortNags([code, ...others]);
}

/** The code `choice` uses after a move by `mover`. */
const nagCode = (choice: NagChoice, mover: Color) =>
  mover === "b" ? (choice.black ?? choice.code) : choice.code;

/** Whether `nags` include `choice`, for either side. */
export const hasNag = (nags: readonly number[], choice: NagChoice) =>
  nags.includes(choice.code) || (choice.black !== undefined && nags.includes(choice.black));

/**
 * `nags` with `choice` added for `mover`, or removed if it is already there. A position
 * assessment replaces any other one.
 */
export function toggleNagChoice(
  nags: readonly number[],
  choice: NagChoice,
  mover: Color,
): number[] {
  const without = nags.filter((code) => code !== choice.code && code !== choice.black);
  if (hasNag(nags, choice)) return without;
  const code = nagCode(choice, mover);
  const kept = isPositionCode(code) ? without.filter((n) => !isPositionCode(n)) : without;
  return sortNags([...kept, code]);
}
