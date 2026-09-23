import { Box, Text } from "ink";
import React from "react";

import { StatusMessage } from "@/components/ui/status-message";
import { useTheme } from "@/hooks/use-theme";
import { CONTROL, type Member } from "@/chat/store";

/// One line under the input: what enter will do, or what the chat is busy with.
export const Footer = ({ text, busy, members, room, attachments = 0 }: { text: string; busy: string | null; members: Map<string, Member>; room: string; attachments?: number }) => {
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
  const files = attachments ? ` with ${attachments} file${attachments > 1 ? "s" : ""}` : "";
  if (!text) return line(<Text color={muted}>@ to address an agent · / for commands · shift+enter new line · ctrl+v pastes an image · /help</Text>);
  // the first mention anywhere is who the message is for, so the hint follows it too
  const mentions = [...text.matchAll(/(^|\s)@([^\s]+)/g)].map((m) => m[2]!.replace(/[.,:;!?]+$/, ""));
  const head = mentions.find((n) => members.has(n)) ?? (text.startsWith("@") ? mentions[0] : undefined);
  if (head) {
    const name = head;
    const m = members.get(name);
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
          enter types this{files} into {m.name}
          {m.connected ? "" : " when it comes back"}
        </Text>
      );
    return line(<Text color={muted}>enter sends this{files} to {m.name} directly</Text>);
  }
  if (text.startsWith("/")) return line(<Text color={muted}>enter runs the command</Text>);
  if (CONTROL.test(text)) return line(<Text color={theme.colors.warning}>control commands go to an agent: @Alex !cancel</Text>);
  return line(<Text color={muted}>enter posts to {room}{files}</Text>);
};
