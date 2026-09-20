import { Box, Text } from "ink";
import React from "react";

import { StatusMessage } from "@/components/ui/status-message";
import { useTheme } from "@/hooks/use-theme";
import { CONTROL, type Member } from "@/chat/store";

/// One line under the input: what enter will do, or what the chat is busy with.
export const Footer = ({ text, busy, members, room }: { text: string; busy: string | null; members: Map<string, Member>; room: string }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const line = (node: React.ReactNode) => (
    <Box paddingLeft={2}>
      <Text wrap="truncate-end">{node}</Text>
    </Box>
  );
  if (busy)
    return (
      <Box paddingLeft={2}>
        <StatusMessage variant="loading">{busy}</StatusMessage>
      </Box>
    );
  if (!text) return line(<Text color={muted}>@ to address an agent · / for commands · ctrl+j new line · ↑ history · /help</Text>);
  const head = text.match(/^@([^\s]+)/);
  if (head) {
    const name = head[1]!;
    const m = members.get(name);
    if (name === "auto") return line(<Text color={muted}>enter sends it to whichever agent the hub picks</Text>);
    if (!m)
      return line(
        <Text>
          <Text color={theme.colors.warning}>nobody called {name} is in this room</Text>
          <Text color={muted}> · /say to post it anyway</Text>
        </Text>
      );
    if (m.kind === "agent")
      return line(
        <Text color={muted}>
          enter types this into {m.name}
          {m.connected ? "" : " when it comes back"}
        </Text>
      );
    return line(<Text color={muted}>enter sends this to {m.name} directly</Text>);
  }
  if (text.startsWith("/")) return line(<Text color={muted}>enter runs the command</Text>);
  if (CONTROL.test(text)) return line(<Text color={theme.colors.warning}>control commands go to an agent: @Alex !cancel</Text>);
  return line(<Text color={muted}>enter posts to {room}</Text>);
};
