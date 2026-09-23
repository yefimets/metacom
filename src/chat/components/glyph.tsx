import cliSpinners from "cli-spinners";
import { Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { useUnicode } from "@/hooks/use-unicode";
import { type Member, stateOf } from "@/chat/store";

export const SPIN_INTERVAL = cliSpinners.dots.interval;
const ASCII_FRAMES = ["-", "\\", "|", "/"];

/// One frame of the dots spinner. The tick lives in the chat root (app.tsx), so every spinner
/// moves in step and each frame re-renders the whole tree: Ink places the terminal cursor only
/// on renders the composer takes part in, so a spinner with a timer of its own hid the cursor
/// on every frame.
export const Spin = ({ frame, color }: { frame: number; color: string }) => {
  const unicode = useUnicode();
  const set = unicode ? cliSpinners.dots.frames : ASCII_FRAMES;
  return <Text color={color}>{set[frame % set.length]}</Text>;
};

/// One character that says what a member is doing; a working agent spins when given a `frame`.
export const Glyph = ({ member, frame }: { member: Member; frame?: number }) => {
  const theme = useTheme();
  const state = stateOf(member);
  if (member.kind === "human") return <Text color={member.connected ? theme.colors.success : theme.colors.mutedForeground}>{member.connected ? "◆" : "◇"}</Text>;
  if (state === "working") return frame === undefined ? <Text color={theme.colors.success}>●</Text> : <Spin frame={frame} color={theme.colors.success} />;
  if (state === "online") return <Text color={theme.colors.success}>●</Text>;
  return <Text color={theme.colors.mutedForeground}>○</Text>;
};
