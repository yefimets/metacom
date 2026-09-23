import { Box, Text, useBoxMetrics, useCursor } from "ink";
import React, { useRef } from "react";

import { useTheme } from "@/hooks/use-theme";
import { useUnicode } from "@/hooks/use-unicode";
import { resolveBorderStyle } from "@/lib/terminal-style";
import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";

/// A row of the input with attachment tokens such as `[image 2.png]` in the accent colour.
/// A token cut by the wrap is shown plain on both rows.
const Tokens = ({ row, tokens, color }: { row: string; tokens: string[]; color: string }) => {
  if (tokens.length === 0) return <Text>{row}</Text>;
  const parts: React.ReactNode[] = [];
  let i = 0;
  let last = 0;
  while (i < row.length) {
    const hit = tokens.find((t) => row.startsWith(t, i));
    if (!hit) {
      i++;
      continue;
    }
    if (i > last) parts.push(<Text key={parts.length}>{row.slice(last, i)}</Text>);
    parts.push(
      <Text key={parts.length} color={color}>
        {hit}
      </Text>
    );
    i += hit.length;
    last = i;
  }
  if (last < row.length) parts.push(<Text key={parts.length}>{row.slice(last)}</Text>);
  return <Text>{parts}</Text>;
};

export const INPUT_ROWS = 6;

type Layout = { rows: string[]; cursor: { row: number; col: number } };

/// Character-wrap the editor's lines to `width` columns and find the cursor's visual cell.
export const layout = (text: string, cursor: number, width: number): Layout => {
  const rows: string[] = [];
  let at = { row: 0, col: 0 };
  let index = 0;
  for (const line of text.split("\n")) {
    let cur = "";
    let w = 0;
    if (cursor === index) at = { row: rows.length, col: 0 };
    for (const g of splitGraphemes(line)) {
      const gw = terminalWidth(g);
      if (w + gw > width) {
        rows.push(cur);
        cur = "";
        w = 0;
      }
      cur += g;
      w += gw;
      index += g.length;
      if (cursor === index) at = { row: rows.length, col: w };
    }
    rows.push(cur);
    // the cursor at the end of an exactly full row belongs at the start of the next one
    if (w === width && cursor === index) {
      at = { row: rows.length, col: 0 };
      rows.push("");
    }
    index += 1;
  }
  return { rows, cursor: at };
};

/// The input box: a rounded frame in the theme's border colour, a `❯` prompt, character-wrapped
/// lines, a window of INPUT_ROWS rows that follows the cursor, and the real terminal cursor.
/// `tokens` are the attachment placeholders in the text, drawn in the accent colour.
export const Composer = ({ text, cursor, width, placeholder, tokens = [], origin }: { text: string; cursor: number; width: number; placeholder: string; tokens?: string[]; origin?: { left: number; top: number } }) => {
  const theme = useTheme();
  const unicode = useUnicode();
  const ref = useRef(null);
  const metrics = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();
  const textW = Math.max(10, width - 6);
  const { rows, cursor: at } = layout(text, cursor, textW);
  let top = 0;
  if (rows.length > INPUT_ROWS) top = Math.max(0, Math.min(at.row - INPUT_ROWS + 1, rows.length - INPUT_ROWS));
  const shown = rows.slice(top, top + INPUT_ROWS);
  const above = top;
  const below = rows.length - top - shown.length;
  const cursorRow = at.row - top;
  const measured = metrics.hasMeasured && origin !== undefined;
  // Set during render, as Ink's docs do: useCursor only stores the value and hands it to the
  // renderer in this component's commit, so setting it in an effect left the cursor one render
  // behind the text. Metrics are relative to the parent box; `origin` is where that parent sits
  // on the screen, which is Ink's cursor origin.
  // +1 for the box's top border, +1 more for the "↑ N more lines" row when the window scrolled
  setCursorPosition(measured ? { x: origin.left + metrics.left + 4 + at.col, y: origin.top + metrics.top + 1 + (above > 0 ? 1 : 0) + cursorRow } : undefined);
  const muted = theme.colors.mutedForeground;
  return (
    <Box ref={ref} flexDirection="column" borderStyle={resolveBorderStyle(theme.border.style, unicode)} borderColor={theme.colors.border} paddingX={1} width={width}>
      {above > 0 && (
        <Text color={muted}>
          {"  ↑ "}{above} more line{above > 1 ? "s" : ""}
        </Text>
      )}
      {shown.map((row, i) => (
        <Box key={top + i} flexDirection="row">
          <Text color={theme.colors.primary} bold>
            {top + i === 0 ? "❯ " : "  "}
          </Text>
          {text === "" && i === 0 ? (
            <Text color={muted}>{measured ? placeholder : "▌" + placeholder}</Text>
          ) : measured || cursorRow !== i ? (
            <Tokens row={row} tokens={tokens} color={theme.colors.accent} />
          ) : (
            <Text>
              {row.slice(0, at.col)}
              <Text inverse>{row.slice(at.col, at.col + 1) || " "}</Text>
              {row.slice(at.col + 1)}
            </Text>
          )}
        </Box>
      ))}
      {below > 0 && (
        <Text color={muted}>
          {"  ↓ "}{below} more line{below > 1 ? "s" : ""}
        </Text>
      )}
    </Box>
  );
};
