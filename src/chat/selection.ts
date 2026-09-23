import { createRequire } from "node:module";

import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";

const require = createRequire(import.meta.url);
type Wrap = (text: string, columns: number, options?: { hard?: boolean; trim?: boolean; wordWrap?: boolean }) => string;
const wrapped = require("wrap-ansi") as Wrap | { default: Wrap };
const wrapAnsi: Wrap = typeof wrapped === "function" ? wrapped : wrapped.default;

/// A drag over the conversation, in screen cells. `anchor` is where the button went down.
export type Selection = { anchor: { row: number; col: number }; head: { row: number; col: number }; copied?: boolean };

/// The message body as the screen shows it: the same wrap Ink applies, computed once so a
/// selection can be drawn on it and the exact text copied back out.
export const wrapLines = (text: string, width: number): string[] =>
  text
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : wrapAnsi(line, Math.max(1, width), { hard: true, trim: false }).split("\n")));

/// Both ends in reading order.
export const ordered = (s: Selection): { top: { row: number; col: number }; bottom: { row: number; col: number } } => {
  const a = s.anchor;
  const b = s.head;
  const first = a.row < b.row || (a.row === b.row && a.col <= b.col);
  return first ? { top: a, bottom: b } : { top: b, bottom: a };
};

export const isEmpty = (s: Selection | null): boolean => !s || (s.anchor.row === s.head.row && s.anchor.col === s.head.col);

/// Which part of the line drawn at `row` (screen row, and `left` its first column) the
/// selection covers, as grapheme offsets into that line. Null when the row is outside it.
export const sliceOf = (s: Selection | null, row: number, left: number, line: string): { from: number; to: number } | null => {
  if (isEmpty(s)) return null;
  const { top, bottom } = ordered(s!);
  if (row < top.row || row > bottom.row) return null;
  const width = terminalWidth(line);
  // a screen column (1-based, as the terminal reports it) back to an offset in the line,
  // counting the width each grapheme takes
  const cell = (col: number): number => {
    const want = col - 1 - left;
    let at = 0;
    let taken = 0;
    for (const g of splitGraphemes(line)) {
      if (taken >= want) break;
      taken += terminalWidth(g);
      at += 1;
    }
    return at;
  };
  const from = row === top.row ? cell(top.col) : 0;
  const to = row === bottom.row ? cell(bottom.col) : splitGraphemes(line).length;
  const end = row === bottom.row && bottom.col - left >= width ? splitGraphemes(line).length : to;
  return from >= end ? null : { from, to: end };
};

/// The text a selection covers, given every line it may touch: [{ row, left, text }].
export const textOf = (s: Selection | null, lines: { row: number; left: number; text: string }[]): string => {
  if (isEmpty(s)) return "";
  const out: string[] = [];
  for (const line of lines.sort((a, b) => a.row - b.row)) {
    const slice = sliceOf(s, line.row, line.left, line.text);
    if (!slice) continue;
    out.push(splitGraphemes(line.text).slice(slice.from, slice.to).join(""));
  }
  return out.join("\n");
};
