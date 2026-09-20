import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { Highlighted, Name } from "@/chat/components/text";
import { nameColor } from "@/chat/palette";
import type { Member, Message } from "@/chat/store";

const TIME_W = 6;

export const time = (ts: string): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/// A room message: time, sender, and the text with hanging indent. Directed messages carry an
/// arrow to the recipient; control commands are set apart in the accent colour.
export const MessageLine = ({ msg, grouped, members, nameW }: { msg: Message; grouped: boolean; members: Map<string, Member>; nameW: number }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  if (msg.kind === "system") {
    return (
      <Box flexDirection="row">
        <Box width={TIME_W}>
          <Text color={muted}>{time(msg.ts)}</Text>
        </Box>
        <Box width={nameW + 2}>
          <Text color={muted}>·</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={muted} wrap="wrap">
            {msg.text}
          </Text>
        </Box>
      </Box>
    );
  }
  const from = msg.from?.name ?? "?";
  const kind = members.get(from)?.kind ?? msg.from?.kind;
  const control = msg.kind === "control";
  return (
    <Box flexDirection="row">
      <Box width={TIME_W}>
        <Text color={muted}>{grouped ? "" : time(msg.ts)}</Text>
      </Box>
      <Box width={nameW + 2}>{grouped ? <Text> </Text> : <Name name={from} kind={kind} />}</Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="row">
        {msg.to && (
          <Text>
            <Text color={control ? theme.colors.accent : msg.kind === "info" ? muted : theme.colors.foreground}>{control ? "⌘" : "→"}</Text>{" "}
            <Text color={nameColor(msg.to)} bold>
              @{msg.to}
            </Text>{" "}
          </Text>
        )}
        {control ? (
          <Text color={theme.colors.accent} wrap="wrap">
            {msg.text}
          </Text>
        ) : (
          <Highlighted text={msg.text} members={members} />
        )}
      </Box>
    </Box>
  );
};
