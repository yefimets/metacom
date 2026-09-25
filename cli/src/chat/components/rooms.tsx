import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { padToTerminalWidth } from "@/lib/terminal-text";
import { Glyph } from "@/chat/components/glyph";
import { nameColor } from "@/chat/palette";
import { ROOM, type Member, type RoomSummary } from "@/chat/store";

export type PickerItem = { room: string; summary?: RoomSummary; create?: boolean; member?: Member };

/// The rooms the list shows for what is typed: the ones whose name contains it, and, when the
/// name is new and a valid room name, a last row that creates it.
export const pickerItems = (rooms: RoomSummary[], filter: string, current: string, create = true): PickerItem[] => {
  const q = filter.trim();
  // only names that can be opened: an old member can still sit in "*", which is no room
  const shown: PickerItem[] = rooms.filter((r) => ROOM.test(r.room) && r.room.toLowerCase().includes(q.toLowerCase())).map((r) => ({ room: r.room, summary: r }));
  // the room you are in is listed even before the hub has heard it spoken in
  if (!rooms.some((r) => r.room === current) && current.toLowerCase().includes(q.toLowerCase())) shown.unshift({ room: current });
  if (create && q && ROOM.test(q) && !shown.some((r) => r.room === q)) return [...shown, { room: q, create: true }];
  return shown;
};

const counts = (s?: RoomSummary): string => {
  if (!s || s.agents === 0) return "no agents";
  const parts = [`${s.online}/${s.agents} online`];
  if (s.working) parts.push(`${s.working} working`);
  if (s.blocked) parts.push(`${s.blocked} need you`);
  return parts.join(" · ");
};

/// The room list that takes the conversation's place: `›` on the chosen row, the room you are
/// in marked, and the counts in the quiet colour. Scrolls to keep the chosen row in sight.
export const RoomPicker = ({ rooms, filter, index, current, height }: { rooms: RoomSummary[]; filter: string; index: number; current: string; height: number }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const items = pickerItems(rooms, filter, current);
  const at = Math.min(index, Math.max(0, items.length - 1));
  const rows = Math.max(1, height - 2);
  const top = Math.max(0, Math.min(at - rows + 1, items.length - rows));
  const nameW = Math.min(28, Math.max(8, ...items.map((i) => i.room.length + 2)));
  return (
    <Box flexDirection="column" height={Math.max(1, height)} justifyContent="flex-end">
      <Text color={muted}>rooms</Text>
      <Box height={1} />
      {items.length === 0 && <Text color={muted}>{rooms.length ? "no room matches · type a name to create one" : "loading…"}</Text>}
      {items.slice(top, top + rows).map((item, i) => {
        const active = top + i === at;
        const mark = active ? "›" : " ";
        if (item.create) {
          return (
            <Text key={"+" + item.room} wrap="truncate-end">
              <Text color={theme.colors.primary}>{mark}</Text>{" "}
              <Text color={active ? theme.colors.primary : theme.colors.foreground} bold={active}>
                + create {item.room}
              </Text>
            </Text>
          );
        }
        return (
          <Text key={item.room} wrap="truncate-end">
            <Text color={theme.colors.primary}>{mark}</Text>{" "}
            <Text color={active ? theme.colors.primary : theme.colors.foreground} bold={active}>
              {padToTerminalWidth(item.room, nameW)}
            </Text>
            <Text color={muted}>
              {counts(item.summary)}
              {item.room === current ? "  · you are here" : ""}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
};

/// Forwarding into another room: the room itself (everyone there) first, then its members,
/// people before agents, filtered by what is typed.
export const memberItems = (room: string, members: Member[], filter: string): PickerItem[] => {
  const q = filter.trim().toLowerCase();
  const rank = (m: Member) => (m.kind === "human" ? 0 : 1) + (m.connected ? 0 : 2);
  const shown = members
    .filter((m) => m.name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((m) => ({ room, member: m }));
  return q && !room.toLowerCase().includes(q) ? shown : [{ room }, ...shown];
};

/// The second step of forwarding to another room: who in it gets the message.
export const MemberPicker = ({ room, members, filter, index, height }: { room: string; members: Member[] | null; filter: string; index: number; height: number }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const items = memberItems(room, members ?? [], filter);
  const at = Math.min(index, Math.max(0, items.length - 1));
  const rows = Math.max(1, height - 2);
  const top = Math.max(0, Math.min(at - rows + 1, items.length - rows));
  return (
    <Box flexDirection="column" height={Math.max(1, height)} justifyContent="flex-end">
      <Text color={muted}>forward to someone in {room}</Text>
      <Box height={1} />
      {members === null && <Text color={muted}>loading…</Text>}
      {items.slice(top, top + rows).map((item, i) => {
        const active = top + i === at;
        const mark = <Text color={theme.colors.primary}>{active ? "›" : " "}</Text>;
        if (!item.member) {
          return (
            <Text key={"#" + item.room} wrap="truncate-end">
              {mark}{" "}
              <Text color={active ? theme.colors.primary : theme.colors.foreground} bold={active}>
                everyone in {item.room}
              </Text>
            </Text>
          );
        }
        const m = item.member;
        return (
          <Text key={m.name} wrap="truncate-end">
            {mark} <Glyph member={m} />{" "}
            <Text color={nameColor(m.name)} bold={active}>
              {m.name}
            </Text>
            <Text color={muted}>
              {"  "}
              {m.connected ? (m.kind === "agent" ? m.status : "online") : "offline, gets it later"}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
};
