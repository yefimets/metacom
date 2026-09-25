import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import type { Tone } from "@/chat/store";
import { time } from "@/chat/components/message";

/// A line of the chat's own that has to stay: a warning, an error, an agent that needs you.
/// Drawn like the room's "misha joined" lines, quiet and on one row, with the time after it;
/// only the dot takes the tone's colour.
export const Note = ({ text, tone, ts }: { text: string; tone: Tone; ts?: string }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const dot = tone === "warn" ? theme.colors.warning : tone === "error" ? theme.colors.error : muted;
  return (
    <Box>
      <Text color={muted} wrap="wrap">
        <Text color={dot}>·</Text> {text}  {ts ? time(ts) : ""}
      </Text>
    </Box>
  );
};

export const Rule = ({ text }: { text: string }) => {
  const theme = useTheme();
  return (
    <Box paddingLeft={2}>
      <Text color={theme.colors.mutedForeground}>
        {"─".repeat(24)} {text}
      </Text>
    </Box>
  );
};
