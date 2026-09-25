import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { padToTerminalWidth } from "@/lib/terminal-text";
import { ROOM, type RoomSummary } from "@/chat/store";

export type PickerItem = { room: string; summary?: RoomSummary; create?: boolean };

/// The rooms the list shows for what is typed: the ones whose name contains it, and, when the
/// name is new and a valid room name, a last row that creates it.
export const pickerItems = (rooms: RoomSummary[], filter: string, current: string): PickerItem[] => {
  const q = filter.trim();
  const shown: PickerItem[] = rooms.filter((r) => r.room.toLowerCase().includes(q.toLowerCase())).map((r) => ({ room: r.room, summary: r }));
  // the room you are in is listed even before the hub has heard it spoken in
  if (!rooms.some((r) => r.room === current) && current.toLowerCase().includes(q.toLowerCase())) shown.unshift({ room: current });
  if (q && ROOM.test(q) && !shown.some((r) => r.room === q)) return [...shown, { room: q, create: true }];
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
