import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { Highlighted, Name } from "@/chat/components/text";
import { nameColor } from "@/chat/palette";
import type { Member, Message } from "@/chat/store";

export const time = (ts: string): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/// A room message in two lines: who and when on top, the text below at full width. Consecutive
/// messages from one sender drop the header, so a burst reads as one block. Directed messages
/// carry an arrow to the recipient; control commands are set apart in the accent colour.
export const MessageLine = ({ msg, grouped, members }: { msg: Message; grouped: boolean; members: Map<string, Member>; nameW?: number }) => {
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
  const files = msg.media?.filter((m) => !msg.text.includes(`[${m.name}]`)) ?? [];
  return (
    <Box flexDirection="column" marginTop={grouped ? 0 : 1}>
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
          <Text color={muted}>{"  " + time(msg.ts)}</Text>
        </Text>
      )}
      <Box flexDirection="row">
        {control ? (
          <Text color={theme.colors.accent} wrap="wrap">
            {msg.text}
          </Text>
        ) : (
          <Highlighted text={msg.text} members={members} />
        )}
        {files.length > 0 && (
          <Text color={muted} wrap="wrap">
            {msg.text ? " " : ""}
            {files.map((m) => `[${m.name}]`).join(" ")}
          </Text>
        )}
      </Box>
    </Box>
  );
};
