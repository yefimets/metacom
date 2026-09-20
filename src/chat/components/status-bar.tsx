import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { Glyph } from "@/chat/components/glyph";
import { nameColor } from "@/chat/palette";
import { type Member, stateOf } from "@/chat/store";

const rank = (m: Member): number => {
  const s = stateOf(m);
  return s === "blocked" ? 0 : s === "done" ? 1 : m.connected ? 2 : 3;
};

/// The line above the input: room, every other member with a live glyph, who I am.
/// One Text per side so a narrow terminal truncates instead of squeezing the flexbox.
export const StatusBar = ({ room, members, me, url }: { room: string; members: Map<string, Member>; me: string; url: string }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const list = [...members.values()].filter((m) => m.name !== me).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return (
    <Box flexDirection="row" paddingX={1} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold>{room}</Text>
          {"   "}
          {list.length === 0 && <Text color={muted}>nobody else here</Text>}
          {list.map((m, i) => {
            const s = stateOf(m);
            return (
              <Text key={m.name}>
                {i > 0 ? "   " : ""}
                <Glyph member={m} /> <Text color={s === "offline" ? muted : nameColor(m.name)}>{m.name}</Text>
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
          {me} · {url.replace(/^wss?:\/\//, "").replace(/\/$/, "")}
        </Text>
      </Box>
    </Box>
  );
};
