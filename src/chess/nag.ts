// Numeric annotation glyphs (NAGs) as PGN stores them, and the symbols the notation shows.

/** Move-quality annotations, which a move has at most one of. */
export type Nag = "!!" | "!" | "!?" | "?!" | "?" | "??";

/** The annotations offered in the notation toolbar, best to worst. */
export const NAGS: readonly Nag[] = ["!!", "!", "!?", "?!", "?"];

export const NAG_CODES: Record<Nag, number> = {
  "!": 1,
  "?": 2,
  "!!": 3,
  "??": 4,
  "!?": 5,
  "?!": 6,
};

const QUALITY_BY_CODE = new Map(Object.entries(NAG_CODES).map(([nag, code]) => [code, nag as Nag]));

/** Position assessments and other common NAGs, shown after the move-quality one. */
const SYMBOLS: Record<number, string> = {
  7: "□",
  10: "=",
  13: "∞",
  14: "⩲",
  15: "⩱",
  16: "±",
  17: "∓",
  18: "+−",
  19: "−+",
  22: "⨀",
  23: "⨀",
  32: "⟳",
  33: "⟳",
  36: "→",
  37: "→",
  40: "↑",
  41: "↑",
  132: "⇆",
  133: "⇆",
  140: "∆",
  146: "N",
};

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
  return nags
    .filter((code) => !QUALITY_BY_CODE.has(code))
    .map((code) => SYMBOLS[code] ?? "")
    .join("");
}

/** `nags` with the move-quality annotation set to `nag`, or cleared if it already was `nag`. */
export function toggleQualityNag(nags: readonly number[], nag: Nag): number[] {
  const code = NAG_CODES[nag];
  const others = nags.filter((n) => !QUALITY_BY_CODE.has(n));
  return nags.includes(code) ? others : [code, ...others];
}
