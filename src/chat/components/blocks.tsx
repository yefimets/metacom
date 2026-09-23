import { Box, Text } from "ink";
import React from "react";

import { Divider } from "@/components/ui/divider";
import { useTheme } from "@/hooks/use-theme";
import { useUnicode } from "@/hooks/use-unicode";
import { resolveBorderStyle } from "@/lib/terminal-style";
import { padToTerminalWidth, terminalWidth } from "@/lib/terminal-text";
import { Glyph } from "@/chat/components/glyph";
import { Name } from "@/chat/components/text";
import { COMMANDS, type Member, type RoomSummary, stateOf } from "@/chat/store";

/// The first thing on screen: where you are and the three things worth knowing.
export const Banner = ({ room, url, me, role }: { room: string; url: string; me: string; role: string }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  return (
    <Box flexDirection="column" paddingX={1} marginY={1}>
      <Text>
        <Text bold color={theme.colors.primary}>
          metacom
        </Text>
        <Text color={muted}> · </Text>
        <Text bold>{room}</Text>
        <Text color={muted}> at {url.replace(/\/$/, "")} as </Text>
        <Name name={me} />
        <Text color={muted}> ({role})</Text>
      </Text>
      <Text color={muted} wrap="wrap">
        @Name to address an agent · / for commands · /help for keys
      </Text>
    </Box>
  );
};

/// /agents: one row per member, like the status bar but with host, repo and capabilities.
export const MemberRows = ({ members }: { members: Member[] }) => {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  const nameW = Math.max(6, ...members.map((m) => terminalWidth(m.name)));
  const home = process.env["HOME"] ?? "";
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {members.map((m) => {
        const state = stateOf(m);
        const accept = m.kind === "agent" && m.accept ? "accepts " + (Array.isArray(m.accept) ? m.accept.join(",") : m.accept) : "";
        const info = [m.host ? "@" + m.host : "", m.repo ? m.repo.replace(home, "~") : "", m.caps?.length ? "[" + m.caps.join(",") + "]" : "", accept, m.reason && (state === "blocked" || state === "working") ? "(" + m.reason + ")" : ""].filter(Boolean).join("  ");
        return (
          <Text key={m.name} wrap="truncate-end">
            <Glyph member={m} animate={false} /> <Name name={padToTerminalWidth(m.name, nameW)} kind={m.kind} /> <Text color={muted}>{padToTerminalWidth(state, 8)}</Text>{" "}
            <Text color={muted}>{info}</Text>
          </Text>
        );
      })}
    </Box>
  );
};

/// /read: the agent's screen in a quiet frame.
export const Screen = ({ name, text }: { name: string; text: string }) => {
  const theme = useTheme();
  const unicode = useUnicode();
  const lines = text.replace(/\s+$/, "").split("\n");
  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      <Divider label={`${name} screen`} labelColor={theme.colors.foreground} color={theme.colors.border} />
      <Box flexDirection="column" borderStyle={resolveBorderStyle("single", unicode)} borderColor={theme.colors.border} borderTop={false} borderRight={false} borderBottom={false} paddingLeft={1}>
        {lines.map((l, i) => (
          <Text key={i} color={theme.colors.mutedForeground} wrap="truncate-end">
            {l || " "}
          </Text>
        ))}
      </Box>
      <Divider color={theme.colors.border} />
    </Box>
  );
};

export const Rooms = ({ rooms, current }: { rooms: RoomSummary[]; current: string }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rooms.map((r) => (
        <Box key={r.room} flexDirection="row">
          <Box width={16}>
            <Text bold={r.room === current}>{r.room}</Text>
          </Box>
          <Text color={theme.colors.mutedForeground}>
            {r.online}/{r.agents} online · {r.working} working · {r.blocked} blocked · {r.attention} done
          </Text>
        </Box>
      ))}
    </Box>
  );
};

const Row = ({ k, v }: { k: string; v: string }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="row">
      <Box width={36}>
        <Text>{k}</Text>
      </Box>
      <Text color={theme.colors.mutedForeground} wrap="wrap">
        {v}
      </Text>
    </Box>
  );
};

export const Help = () => {
  const theme = useTheme();
  const H = ({ children }: { children: string }) => (
    <Text bold color={theme.colors.primary}>
      {children}
    </Text>
  );
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <H>messages</H>
      <Row k="text" v="post to the room; @Name inside is a mention" />
      <Row k="@Alex do the thing" v="typed into that agent when it is idle · a mention later in the sentence addresses it too" />
      <Row k="@Alex !cancel  !keys y  !type ok" v="control an agent that is blocked; acts at once" />
      <H>commands</H>
      {COMMANDS.map((c) => (
        <Row key={c.name} k={`/${c.name} ${c.args}`} v={c.help} />
      ))}
      <H>keys</H>
      <Row k="enter" v="send · shift+enter for a new line (or option+enter, ctrl+j, a trailing \)" />
      <Row k="@ and /" v="open a list; ↑↓ choose, tab or enter inserts, esc closes" />
      <Row k="↑ ↓" v="move between lines, then through history" />
      <Row k="ctrl+a ctrl+e ctrl+w ctrl+u ctrl+k" v="line start, line end, delete word, kill to start, kill to end" />
      <Row k="alt+← alt+→  alt+b alt+f" v="word left, word right" />
      <Row k="esc esc" v="close the list; twice clears the input" />
      <Row k="click a name" v="on the status line, addresses it · /mouse off gives the terminal its selection back" />
      <Row k="wheel · page up/down" v="scroll the conversation; the input stays at the bottom" />
      <Row k="cmd+v / ctrl+v" v="paste the clipboard: an image becomes [image 1.png], a file path the same, text as it is; delete the token to drop the file" />
      <Row k="ctrl+l" v="redraw" />
      <Row k="ctrl+c" v="clear the input, then leave" />
    </Box>
  );
};
