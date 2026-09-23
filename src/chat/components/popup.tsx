import { Box, Text } from "ink";
import React from "react";

import { useTheme } from "@/hooks/use-theme";
import { padToTerminalWidth, terminalWidth } from "@/lib/terminal-text";
import { Glyph } from "@/chat/components/glyph";
import { nameColor } from "@/chat/palette";
import { type Member, stateOf } from "@/chat/store";

export type PopupItem = { label: string; insert: string; member?: Member; command?: { name: string; args: string; help: string } };
export type PopupState = { kind: "mention" | "command" | null; items: PopupItem[]; index: number; query: string; dismissed?: string };

export const POPUP_ROWS = 6;

/// The list over the input for `@` and `/`, in the style of termcn's Select: a `›` cursor
/// and the active row in the primary colour. Driven by the composer's keys, not by focus.
export const Popup = ({ popup, room }: { popup: PopupState; room: number }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const rows = Math.max(1, Math.min(POPUP_ROWS, room));
  const top = Math.max(0, Math.min(popup.index - rows + 1, popup.items.length - rows));
  const nameW = Math.max(6, ...popup.items.map((i) => terminalWidth(i.label))) + 1;
  const home = process.env["HOME"] ?? "";
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {popup.items.slice(top, top + rows).map((item, i) => {
        const active = top + i === popup.index;
        const mark = active ? "›" : " ";
        if (popup.kind === "mention" && item.member) {
          const m = item.member;
          const state = stateOf(m);
          const info = [m.host ? "@" + m.host : "", m.repo ? m.repo.replace(home, "~") : "", m.reason && m.status === "blocked" ? m.reason : ""].filter(Boolean).join("  ");
          return (
            <Text key={item.label} wrap="truncate-end">
              <Text color={theme.colors.primary}>{mark}</Text> <Glyph member={m} />{" "}
              <Text color={nameColor(m.name)} bold={active}>
                {padToTerminalWidth("@" + item.label, nameW)}
              </Text>{" "}
              <Text color={muted}>{padToTerminalWidth(state, 9)}</Text> <Text color={muted}>{info}</Text>
            </Text>
          );
        }
        const c = item.command!;
        return (
          <Text key={item.label} wrap="truncate-end">
            <Text color={theme.colors.primary}>{mark}</Text>{" "}
            <Text color={active ? theme.colors.primary : theme.colors.foreground} bold={active}>
              {padToTerminalWidth("/" + c.name, nameW)}
            </Text>{" "}
            <Text color={muted}>{padToTerminalWidth(c.args, 28)}</Text> <Text color={muted}>{c.help}</Text>
          </Text>
        );
      })}
      <Text color={muted} wrap="truncate-end">
        {"  "}↑↓ choose · tab inserts · esc closes{popup.items.length > rows ? ` · ${popup.items.length} matches` : ""}
      </Text>
    </Box>
  );
};
