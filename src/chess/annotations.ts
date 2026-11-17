// Comments as PGN stores them: free text plus embedded commands such as `[%clk 0:03:00]`. Arrows and
// circles drawn on the board are kept in the lichess/ChessBase commands `[%cal Ge2e4,Rd7d5]` and
// `[%csl Gd4]`, so they travel with the game in any PGN.

import type { Square } from "./board";

export type ShapeColor = "green" | "red" | "blue" | "yellow";

/** An arrow, or a circle when `from` and `to` are the same square. */
export type Shape = { from: Square; to: Square; color: ShapeColor };

const COLOR_CODES: Record<ShapeColor, string> = { green: "G", red: "R", blue: "B", yellow: "Y" };
const COLORS_BY_CODE: Record<string, ShapeColor> = { G: "green", R: "red", B: "blue", Y: "yellow" };

/** A comment split into what people read, the drawn shapes and any other commands. */
export type CommentParts = {
  text: string;
  shapes: Shape[];
  /** Other commands, verbatim, e.g. `[%clk 0:03:00]`. */
  commands: string[];
};

const COMMAND = /\[%(\w+)([^\]]*)\]/g;

/** Splits a comment into its text, shapes and other commands. */
export function parseComment(comment: string | undefined): CommentParts {
  const shapes: Shape[] = [];
  const commands: string[] = [];
  const text = (comment ?? "").replace(COMMAND, (whole, name: string, body: string) => {
    if (name === "cal" || name === "csl") {
      for (const entry of body.split(",")) {
        const shape = parseShape(entry.trim(), name === "csl");
        if (shape && !shapes.some((s) => s.from === shape.from && s.to === shape.to)) {
          shapes.push(shape);
        }
      }
    } else {
      commands.push(whole);
    }
    return " ";
  });
  return { text: text.replace(/\s+/g, " ").trim(), shapes, commands };
}

function parseShape(entry: string, circle: boolean): Shape | undefined {
  const match = circle
    ? /^([GRBY])([a-h][1-8])$/.exec(entry)
    : /^([GRBY])([a-h][1-8])([a-h][1-8])$/.exec(entry);
  if (!match) return undefined;
  const [, code, from, to = from] = match;
  return { from, to, color: COLORS_BY_CODE[code] };
}

/** Joins comment parts back into a comment, or `undefined` when nothing is left. */
export function formatComment(parts: CommentParts): string | undefined {
  const circles = parts.shapes.filter((s) => s.from === s.to);
  const arrows = parts.shapes.filter((s) => s.from !== s.to);
  const pieces = [...parts.commands];
  if (circles.length > 0) {
    pieces.push(`[%csl ${circles.map((s) => `${COLOR_CODES[s.color]}${s.from}`).join(",")}]`);
  }
  if (arrows.length > 0) {
    pieces.push(`[%cal ${arrows.map((s) => `${COLOR_CODES[s.color]}${s.from}${s.to}`).join(",")}]`);
  }
  // The text is kept as typed (minus outer space) so editing it never fights the cursor.
  const text = parts.text.trim();
  if (text) pieces.push(text);
  return pieces.length > 0 ? pieces.join(" ") : undefined;
}

/** `comment` with its text replaced, keeping shapes and commands. */
export function withCommentText(comment: string | undefined, text: string): string | undefined {
  return formatComment({ ...parseComment(comment), text });
}

/** `comment` with its shapes replaced, keeping text and commands. */
export function withShapes(comment: string | undefined, shapes: Shape[]): string | undefined {
  return formatComment({ ...parseComment(comment), shapes });
}

/** Adds `shape`, or removes it when the same shape is already drawn in the same colour. */
export function toggleShape(shapes: readonly Shape[], shape: Shape): Shape[] {
  const existing = shapes.find((s) => s.from === shape.from && s.to === shape.to);
  const rest = shapes.filter((s) => s !== existing);
  return existing?.color === shape.color ? rest : [...rest, shape];
}
