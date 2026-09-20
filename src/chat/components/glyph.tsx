import cliSpinners from "cli-spinners";
import { Text } from "ink";
import React from "react";

import { useAnimation } from "@/hooks/use-animation";
import { useTheme } from "@/hooks/use-theme";
import { useUnicode } from "@/hooks/use-unicode";
import { type Member, stateOf } from "@/chat/store";

/// termcn's spinner as a bare Text, so it can sit inside a single-line Text row.
const Dots = ({ color }: { color: string }) => {
  const unicode = useUnicode();
  const { frames, interval } = cliSpinners.dots;
  const frame = useAnimation({ intervalMs: interval });
  const set = unicode ? frames : ["-", "\\", "|", "/"];
  return <Text color={color}>{set[frame % set.length]}</Text>;
};

/// One character that says what a member is doing; working agents get a live spinner.
export const Glyph = ({ member, animate = true }: { member: Member; animate?: boolean }) => {
  const theme = useTheme();
  const state = stateOf(member);
  if (member.kind === "human") return <Text color={member.connected ? theme.colors.success : theme.colors.mutedForeground}>{member.connected ? "◆" : "◇"}</Text>;
  if (member.kind === "route") return <Text color={theme.colors.accent}>◎</Text>;
  if (state === "working") return animate ? <Dots color={theme.colors.success} /> : <Text color={theme.colors.success}>●</Text>;
  if (state === "waiting") return <Text color={theme.colors.success}>●</Text>;
  if (state === "blocked")
    return (
      <Text color={theme.colors.warning} bold>
        !
      </Text>
    );
  if (state === "done") return <Text color={theme.colors.info}>✓</Text>;
  if (state === "starting") return <Text color={theme.colors.mutedForeground}>◌</Text>;
  return <Text color={theme.colors.mutedForeground}>○</Text>;
};
