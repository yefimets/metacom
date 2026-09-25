import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { useUnicode } from "@/hooks/use-unicode";
import { terminalWidth } from "@/lib/terminal-text";
import { Glyph } from "@/chat/components/glyph";
import { nameColor } from "@/chat/palette";
import { type Member, type MyCall, type Participant, stateOf } from "@/chat/store";

const rank = (m: Member): number => (stateOf(m) === "working" ? 0 : 1);

const suffixOf = (m: Member): string => (stateOf(m) === "working" ? " working" : "");

/// Two cells of level meter by a name in the call: bars that move while the voice comes
/// through, flat while the mic is open and quiet, dim and flat when muted.
const BARS = ["▂▅", "▅▇", "▇▃", "▃▆", "▆▂", "▄▇", "▇▅", "▅▂"];
const BARS_ASCII = ["-=", "=#", "#=", "=-"];
const BADGE_W = 2;

export const Bars = ({ mic, speaking, frame, idle }: { mic: boolean; speaking: boolean; frame: number; idle?: boolean }) => {
  const theme = useTheme();
  const unicode = useUnicode();
  if (idle) return <Text color={theme.colors.mutedForeground}>{unicode ? "◌ " : "o "}</Text>;
  if (!mic) return <Text color={theme.colors.mutedForeground} strikethrough>{unicode ? "▁▁" : "__"}</Text>;
  if (!speaking) return <Text color={theme.colors.success}>{unicode ? "▁▁" : ".."}</Text>;
  const set = unicode ? BARS : BARS_ASCII;
  // the dots spinner ticks every 80 ms; the bars move at half that pace
  return <Text color={theme.colors.success}>{set[Math.floor(frame / 2) % set.length]}</Text>;
};

/// Who is on the line: everyone still connected, the ones needing a look first, then by when
/// they were last active — so the names you are working with stay nearest the left edge. Someone
/// in the call who is not a member here (the phone, signed in without a name) still gets a place.
export const order = (members: Map<string, Member>, me: string, voice: Map<string, Participant> = new Map()): Member[] => {
  const list = [...members.values()]
    .filter((m) => m.name !== me && m.connected)
    .sort((a, b) => rank(a) - rank(b) || String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")) || a.name.localeCompare(b.name));
  for (const p of voice.values()) {
    if (p.name === me || list.some((m) => m.name === p.name)) continue;
    list.push({ name: p.name, kind: "human", room: "", status: "waiting", connected: true, attention: false, reason: null });
  }
  return list;
};

/// Where each name sits on the status line, in terminal columns (0-based), so a mouse click
/// can be turned back into a name. Must follow the render below exactly.
export const segments = (room: string, members: Map<string, Member>, me: string, voice: Map<string, Participant> = new Map()): { name: string; start: number; end: number }[] => {
  let col = 1; // paddingX={1}: the names start at the left edge
  const out: { name: string; start: number; end: number }[] = [];
  order(members, me, voice).forEach((m, i) => {
    if (i > 0) col += 3;
    col += 2; // glyph and its space
    const w = terminalWidth(m.name);
    out.push({ name: m.name, start: col, end: col + w });
    col += w + terminalWidth(suffixOf(m));
    if (voice.has(m.name)) col += 1 + BADGE_W;
  });
  return out;
};

/// My corner of the line, right-aligned in a bar `width` columns wide: the bars (mute) and my
/// name (join or leave the call), in the same 0-based columns as `segments`.
export const mine = (width: number, room: string, me: string): { bars: [number, number]; name: [number, number] } => {
  const right = width - 1; // paddingX={1}
  const start = right - (BADGE_W + 1 + terminalWidth(me) + terminalWidth(" · ") + terminalWidth(room));
  return { bars: [start, start + BADGE_W], name: [start + BADGE_W + 1, start + BADGE_W + 1 + terminalWidth(me)] };
};

/// The line above the input: who is active on the left, who I am and where on the right.
/// One Text per side so a narrow terminal truncates instead of squeezing the flexbox.
export const StatusBar = ({ room, members, me, frame, voice = new Map(), call = null }: { room: string; members: Map<string, Member>; me: string; url?: string; frame: number; mouse?: boolean; voice?: Map<string, Participant>; call?: MyCall | null }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const list = order(members, me, voice);
  return (
    <Box flexDirection="row" paddingX={1} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {list.length === 0 && <Text color={muted}>nobody else here</Text>}
          {list.map((m, i) => {
            const s = stateOf(m);
            const p = voice.get(m.name);
            return (
              <Text key={m.name}>
                {i > 0 ? "   " : ""}
                <Glyph member={m} frame={frame} /> <Text color={s === "offline" ? muted : nameColor(m.name)}>{m.name}</Text>
                {s === "working" && <Text color={muted}> working</Text>}
                {p && (
                  <Text>
                    {" "}
                    <Bars mic={p.mic} speaking={p.speaking} frame={frame} />
                  </Text>
                )}
              </Text>
            );
          })}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={muted}>
          <Bars idle={!call} mic={Boolean(call?.mic)} speaking={Boolean(call?.speaking)} frame={frame} /> <Text color={call ? nameColor(me) : muted}>{me}</Text> · <Text bold color={theme.colors.foreground}>{room}</Text>
        </Text>
      </Box>
    </Box>
  );
};
