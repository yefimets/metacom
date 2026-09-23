import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { terminalWidth } from "@/lib/terminal-text";
import { Glyph } from "@/chat/components/glyph";
import { nameColor } from "@/chat/palette";
import { type Member, stateOf } from "@/chat/store";

const rank = (m: Member): number => {
  const s = stateOf(m);
  return s === "blocked" ? 0 : s === "done" ? 1 : m.connected ? 2 : 3;
};

const suffixOf = (m: Member): string => {
  const s = stateOf(m);
  return s === "blocked" ? " needs you" : s === "working" ? " working" : s === "done" ? " done" : "";
};

/// Who is on the line: everyone still connected, the ones needing a look first, then by when
/// they were last active — so the names you are working with stay nearest the left edge.
export const order = (members: Map<string, Member>, me: string): Member[] =>
  [...members.values()]
    .filter((m) => m.name !== me && m.connected)
    .sort((a, b) => rank(a) - rank(b) || String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")) || a.name.localeCompare(b.name));

/// Where each name sits on the status line, in terminal columns (0-based), so a mouse click
/// can be turned back into a name. Must follow the render below exactly.
export const segments = (room: string, members: Map<string, Member>, me: string): { name: string; start: number; end: number }[] => {
  let col = 1; // paddingX={1}: the names start at the left edge
  const out: { name: string; start: number; end: number }[] = [];
  order(members, me).forEach((m, i) => {
    if (i > 0) col += 3;
    col += 2; // glyph and its space
    const w = terminalWidth(m.name);
    out.push({ name: m.name, start: col, end: col + w });
    col += w + terminalWidth(suffixOf(m));
  });
  return out;
};

/// The line above the input: who is active on the left, who I am and where on the right.
/// One Text per side so a narrow terminal truncates instead of squeezing the flexbox.
export const StatusBar = ({ room, members, me, frame, mouse = false }: { room: string; members: Map<string, Member>; me: string; url?: string; frame: number; mouse?: boolean }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const list = order(members, me);
  return (
    <Box flexDirection="row" paddingX={1} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {list.length === 0 && <Text color={muted}>nobody else here</Text>}
          {list.map((m, i) => {
            const s = stateOf(m);
            return (
              <Text key={m.name}>
                {i > 0 ? "   " : ""}
                <Glyph member={m} frame={frame} /> <Text color={s === "offline" ? muted : nameColor(m.name)}>{m.name}</Text>
                {s === "blocked" && <Text color={theme.colors.warning}> needs you</Text>}
                {s === "working" && <Text color={muted}> working</Text>}
                {s === "done" && <Text color={theme.colors.info}> done</Text>}
              </Text>
            );
          })}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={muted}>
          {mouse && <Text color={theme.colors.accent}>click </Text>}
          {me} · <Text bold color={theme.colors.foreground}>{room}</Text>
        </Text>
      </Box>
    </Box>
  );
};
