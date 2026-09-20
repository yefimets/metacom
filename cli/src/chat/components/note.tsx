import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import type { Tone } from "@/chat/store";

const ICON: Record<Tone, string> = { ok: "✓", warn: "!", error: "✗", dim: "", plain: "" };

/// A line of the chat's own: results, hints, errors. Toned ones get an icon in the theme's
/// status colour; the text wraps under it.
export const Note = ({ text, tone }: { text: string; tone: Tone }) => {
  const theme = useTheme();
  const color = tone === "ok" ? theme.colors.success : tone === "warn" ? theme.colors.warning : tone === "error" ? theme.colors.error : tone === "plain" ? theme.colors.foreground : theme.colors.mutedForeground;
  const icon = ICON[tone];
  return (
    <Box paddingLeft={2}>
      <Text wrap="wrap">
        {icon && (
          <Text color={color} bold>
            {icon}{" "}
          </Text>
        )}
        <Text color={tone === "dim" || tone === "plain" ? color : theme.colors.foreground}>{text}</Text>
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
