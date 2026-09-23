import { Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { nameColor } from "@/chat/palette";
import type { Member } from "@/chat/store";

const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9._-]*)/giu;

/// Message text with @mentions of known members in the member's colour.
export const Highlighted = ({ text, members, color }: { text: string; members: Map<string, Member>; color?: string }) => {
  const theme = useTheme();
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(MENTION)) {
    const [all, pre, word] = m;
    const known = members.has(word!) || word === "auto";
    if (!known) continue;
    const start = m.index! + pre!.length;
    if (start > last) parts.push(<Text key={i++} color={color ?? theme.colors.foreground}>{text.slice(last, start)}</Text>);
    parts.push(
      <Text key={i++} color={nameColor(word!)} bold>
        @{word}
      </Text>
    );
    last = m.index! + all.length;
  }
  if (last < text.length) parts.push(<Text key={i++} color={color ?? theme.colors.foreground}>{text.slice(last)}</Text>);
  return <Text wrap="wrap">{parts}</Text>;
};

export const Name = ({ name, bold = true }: { name: string; kind?: string; bold?: boolean }) => (
  <Text color={nameColor(name.trim())} bold={bold}>
    {name}
  </Text>
);
