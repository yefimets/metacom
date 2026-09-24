import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { splitGraphemes, terminalWidth } from "@/lib/terminal-text";
import { type Selection, sliceOf } from "@/chat/selection";
import { type Line, type Span, renderBody } from "@/chat/markdown";
import { Name } from "@/chat/components/text";
import { nameColor } from "@/chat/palette";
import type { Member, Message } from "@/chat/store";

/// The row of actions under a message. Each one is a glyph and a word, and the gaps are
/// fixed, so a click can be turned back into an action without measuring the screen.
export const ACTIONS = [
  { name: "reply", text: "↩ reply" },
  { name: "forward", text: "↪ forward" },
] as const;
export type Action = (typeof ACTIONS)[number]["name"];
const GAP = 2;
export const actionsText = ACTIONS.map((a) => a.text).join(" ".repeat(GAP));

/// Which action a click at column `c` (0-based, relative to the row's left edge) landed on.
export const actionAt = (c: number): Action | undefined => {
  let col = 0;
  for (const { name, text } of ACTIONS) {
    const w = terminalWidth(text);
    if (c >= col && c < col + w) return name;
    col += w + GAP;
  }
  return undefined;
};

/// A forwarded message carries where it came from at the front of its text, so an agent
/// reading its terminal sees it. On screen it belongs beside the time instead.
export const FORWARDED = /^\[forwarded from ([^\]]+)\]\s*/;
export const bodyOf = (text: string): string => text.replace(FORWARDED, "");

export const time = (ts: string): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/// A room message in two lines: who and when on top, the text below at full width. Consecutive
/// messages from one sender drop the header, so a burst reads as one block. Directed messages
/// carry an arrow to the recipient; control commands are set apart in the accent colour.
/// One span of a drawn line, in the colour its markdown asks for.
const SpanText = ({ span }: { span: Span }) => {
  const theme = useTheme();
  const tone =
    span.tone === "code"
      ? theme.colors.accent
      : span.tone === "mention"
        ? nameColor(span.name ?? span.text.replace(/^@/, ""))
        : span.tone === "muted" || span.tone === "rule"
          ? theme.colors.mutedForeground
          : undefined;
  return (
    <Text color={tone} bold={span.bold || span.tone === "mention"} italic={span.italic}>
      {span.text}
    </Text>
  );
};

/// One line of a message body. A selected part is drawn inverse, which is how a terminal
/// shows its own selection, so a drag looks the way it does everywhere else; the styling
/// steps aside while it is selected, because a terminal shows one selection colour.
const BodyLine = ({ line, row, left, selection }: { line: Line; row: number; left: number; selection: Selection | null }) => {
  const slice = sliceOf(selection, row, left, line.text);
  if (!slice) {
    return (
      <Text>
        {line.spans.map((span, i) => (
          <SpanText key={i} span={span} />
        ))}
      </Text>
    );
  }
  const g = splitGraphemes(line.text);
  return (
    <Text>
      {g.slice(0, slice.from).join("")}
      <Text inverse>{g.slice(slice.from, slice.to).join("")}</Text>
      {g.slice(slice.to).join("")}
    </Text>
  );
};

export const MessageLine = ({ msg, grouped, members, width = 80, top = 0, left = 0, selection = null }: { msg: Message; grouped: boolean; members: Map<string, Member>; width?: number; top?: number; left?: number; selection?: Selection | null; nameW?: number }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  if (msg.kind === "system") {
    return (
      <Box>
        <Text color={muted} wrap="wrap">
          · {msg.text}  {time(msg.ts)}
        </Text>
      </Box>
    );
  }
  const from = msg.from?.name ?? "?";
  const kind = members.get(from)?.kind ?? msg.from?.kind;
  const control = msg.kind === "control";
  // a forwarded message says so beside the time, not in the middle of what was written
  const forwarded = FORWARDED.exec(msg.text);
  const body = bodyOf(msg.text);
  const files = msg.media?.filter((m) => !msg.text.includes(`[${m.name}]`)) ?? [];
  return (
    <Box flexDirection="column">
      {!grouped && (
        <Text>
          <Name name={from} kind={kind} />
          {msg.to && (
            <Text>
              {" "}
              <Text color={control ? theme.colors.accent : msg.kind === "info" ? muted : theme.colors.foreground}>{control ? "⌘" : "→"}</Text>{" "}
              <Text color={nameColor(msg.to)} bold>
                {msg.to}
              </Text>
            </Text>
          )}
          <Text color={muted}>
            {"  " + time(msg.ts)}
            {forwarded ? `  [forwarded from ${forwarded[1]}]` : ""}
          </Text>
        </Text>
      )}
      <Box flexDirection="column">
        {renderBody(body, width, (name) => members.has(name)).map((line, i) =>
          // a blank line the author wrote is a row of its own: an empty Text has no height
          line.text === "" ? (
            <Box key={i} height={1} />
          ) : control ? (
            <Text key={i} color={theme.colors.accent}>
              {line.text}
            </Text>
          ) : (
            <BodyLine key={i} line={line} row={top + i} left={left} selection={selection} />
          )
        )}
        {files.length > 0 && (
          <Text color={muted} wrap="wrap">
            {files.map((m) => `[${m.name}]`).join(" ")}
          </Text>
        )}
      </Box>
      <Box>
        <Text color={theme.colors.mutedForeground}>{actionsText}</Text>
      </Box>
    </Box>
  );
};
