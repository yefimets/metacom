import { Box, Static, useApp, useInput, usePaste, useStdout, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ThemeProvider } from "@/providers/theme-provider";
import { terminalWidth } from "@/lib/terminal-text";
import type { Theme } from "@/components/ui/types";
import { Banner, Help, MemberRows, Rooms, Screen } from "@/chat/components/blocks";
import { Composer } from "@/chat/components/composer";
import { Footer } from "@/chat/components/footer";
import { MessageLine } from "@/chat/components/message";
import { Note, Rule } from "@/chat/components/note";
import { Popup, type PopupItem, type PopupState } from "@/chat/components/popup";
import { StatusBar } from "@/chat/components/status-bar";
import { Editor } from "@/chat/editor";
import { COMMANDS, type Entry, type Member, type Store } from "@/chat/store";
import { themeByName, themeNames } from "@/chat/themes";

/// Rank a candidate against what the user typed: prefix, then substring, then subsequence.
const match = (candidate: string, query: string): number => {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (c.startsWith(q)) return 1;
  if (c.includes(q)) return 2;
  let i = 0;
  for (const ch of c) if (ch === q[i]) i++;
  return i === q.length ? 3 : -1;
};

const EMPTY_POPUP: PopupState = { kind: null, items: [], index: 0, query: "" };

/// What the popup should show for the token at the cursor: members after `@`, commands
/// after a leading `/`. The selection survives while the list stays the same.
const computePopup = (editor: Editor, members: Map<string, Member>, me: string, previous: PopupState): PopupState => {
  const { start, text } = editor.token();
  let kind: PopupState["kind"] = null;
  let items: PopupItem[] = [];
  let query = "";
  if (text.startsWith("@") && !text.includes("@", 1)) {
    kind = "mention";
    query = text.slice(1);
    const all = [...members.values()].filter((m) => m.name !== me);
    if (start === 0 && all.some((m) => m.kind === "agent")) all.push({ name: "auto", kind: "route", room: "", status: "", connected: true, attention: false, reason: null });
    items = all
      .map((m) => ({ m, rank: match(m.name, query) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || (a.m.connected === b.m.connected ? 0 : a.m.connected ? -1 : 1) || a.m.name.localeCompare(b.m.name))
      .map((x) => ({ label: x.m.name, insert: `@${x.m.name} `, member: x.m }));
  } else if (start === 0 && text.startsWith("/")) {
    kind = "command";
    query = text.slice(1);
    items = COMMANDS.map((c) => ({ c, rank: match(c.name, query) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((x) => ({ label: x.c.name, insert: `/${x.c.name} `, command: x.c }));
  }
  const dismissed = previous.dismissed !== undefined && previous.dismissed === text ? previous.dismissed : undefined;
  // a command typed out in full needs no list: enter should run it
  const exact = kind === "command" && items.length > 0 && items[0]!.label.toLowerCase() === query.toLowerCase();
  if (!kind || items.length === 0 || dismissed !== undefined || exact) return { ...EMPTY_POPUP, dismissed };
  const same = previous.kind === kind && previous.items.map((i) => i.label).join() === items.map((i) => i.label).join();
  return { kind, items, index: same ? previous.index : 0, query };
};

const EntryView = ({ entry, members, nameW, state }: { entry: Entry; members: Map<string, Member>; nameW: number; state: Store["state"] }) => {
  switch (entry.type) {
    case "banner":
      return <Banner room={state.room} url={state.url} me={state.me.name} role={state.me.role} />;
    case "message":
      return <MessageLine msg={entry.msg} grouped={entry.grouped} members={members} nameW={nameW} />;
    case "note":
      return <Note text={entry.text} tone={entry.tone} />;
    case "rule":
      return <Rule text={entry.text} />;
    case "members":
      return <MemberRows members={entry.members} />;
    case "screen":
      return <Screen name={entry.name} text={entry.text} />;
    case "rooms":
      return <Rooms rooms={entry.rooms} current={state.room} />;
    case "help":
      return <Help />;
  }
};

const Chat = ({ store, setTheme }: { store: Store; setTheme: (t: Theme) => void }) => {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const { columns, rows } = useWindowSize();
  const { stdout } = useStdout();
  const { exit } = useApp();
  const editor = useRef(new Editor()).current;
  const [, bump] = useState(0);
  const redraw = useCallback(() => bump((n) => n + 1), []);
  const [popup, setPopup] = useState<PopupState>(EMPTY_POPUP);
  const lastEsc = useRef(0);
  const firstSize = useRef(true);

  useEffect(() => {
    store.onBell = () => stdout.write("\u0007");
    store.onQuit = () => exit();
    store.onTheme = (name) => {
      if (!name) return `themes: ${themeNames().join(", ")}`;
      const t = themeByName(name);
      if (!t) return `no theme called ${name} · ${themeNames().join(", ")}`;
      setTheme(t);
      return `theme: ${t.name}`;
    };
  }, [store, stdout, exit, setTheme]);

  // A resize reflows the scrollback unpredictably; clear and draw the recent log again.
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false;
      return;
    }
    stdout.write("\u001B[2J\u001B[H");
    store.replay(rows * 2);
  }, [columns, rows, stdout, store]);

  const refresh = useCallback(() => {
    setPopup((p) => computePopup(editor, store.state.members, store.state.me.name, p));
    redraw();
  }, [editor, store, redraw]);

  const submit = useCallback(() => {
    const text = editor.submit();
    setPopup(EMPTY_POPUP);
    redraw();
    void store.submit(text);
  }, [editor, store, redraw]);

  usePaste((text) => {
    editor.insert(text.replace(/\r\n?/g, "\n"));
    refresh();
  });

  useInput((input, key) => {
    const open = popup.kind !== null;
    if (key.ctrl && input === "c") {
      if (editor.text) {
        editor.clear();
        return refresh();
      }
      return store.quit();
    }
    if (key.ctrl && input === "d" && !editor.text) return store.quit();
    if (key.escape) {
      const twice = Date.now() - lastEsc.current < 900;
      lastEsc.current = Date.now();
      if (open) {
        setPopup({ ...EMPTY_POPUP, dismissed: editor.token().text });
        return redraw();
      }
      if (twice) editor.clear();
      return refresh();
    }
    if (open && (key.upArrow || key.downArrow)) {
      const n = popup.items.length;
      setPopup({ ...popup, index: (popup.index + (key.upArrow ? -1 : 1) + n) % n });
      return;
    }
    if (open && (key.tab || key.return)) {
      const item = popup.items[popup.index];
      if (item) editor.replaceToken(item.insert);
      setPopup(EMPTY_POPUP);
      return refresh();
    }
    if (input === "\n" || (key.return && (key.meta || key.shift))) {
      editor.insert("\n");
      return refresh();
    }
    if (key.return) {
      if (editor.text.endsWith("\\")) {
        editor.backspace();
        editor.insert("\n");
        return refresh();
      }
      return submit();
    }
    if (key.tab) return;
    if (key.backspace) key.meta || key.ctrl ? editor.deleteWordLeft() : editor.backspace();
    else if (key.delete) editor.delete();
    else if (key.leftArrow) key.meta || key.ctrl ? editor.wordLeft() : editor.left();
    else if (key.rightArrow) key.meta || key.ctrl ? editor.wordRight() : editor.right();
    else if (key.upArrow) {
      if (!editor.vertical(-1)) editor.historyPrev();
    } else if (key.downArrow) {
      if (!editor.vertical(1)) editor.historyNext();
    } else if (key.home || (key.ctrl && input === "a")) editor.home();
    else if (key.end || (key.ctrl && input === "e")) editor.end();
    else if (key.ctrl && input === "u") editor.killToStart();
    else if (key.ctrl && input === "k") editor.killToEnd();
    else if (key.ctrl && input === "w") editor.deleteWordLeft();
    else if (key.ctrl && input === "l") {
      stdout.write("\u001B[2J\u001B[H");
      store.replay(rows * 2);
    } else if (key.meta && input === "b") editor.wordLeft();
    else if (key.meta && input === "f") editor.wordRight();
    else if (key.meta && input === "d") editor.deleteWordRight();
    else if (key.ctrl || key.meta || key.pageUp || key.pageDown) return;
    else if (input && !/[\u0000-\u001F\u007F]/.test(input)) editor.insert(input);
    else return;
    refresh();
  });

  const members = state.members;
  const nameW = useMemo(() => Math.min(14, Math.max(6, ...[...members.values()].map((m) => terminalWidth(m.name)))), [members]);
  const width = Math.max(30, columns - 1);
  const footerRoom = rows - 3 - Math.min(6, editor.lines.length) - 3;
  return (
    <Box flexDirection="column" width={columns}>
      <Static key={state.epoch} items={state.log} style={{ flexDirection: "column", width: columns }}>
        {(entry) => <EntryView key={entry.id} entry={entry} members={members} nameW={nameW} state={state} />}
      </Static>
      <StatusBar room={state.room} members={members} me={state.me.name} url={state.url} />
      <Composer text={editor.text} cursor={editor.cursor} width={width} placeholder={`message ${state.room} · @ for agents · / for commands`} />
      {popup.kind ? <Popup popup={popup} room={footerRoom} /> : <Footer text={editor.text} busy={state.busy} members={members} room={state.room} />}
    </Box>
  );
};

export const App = ({ store, theme }: { store: Store; theme: Theme }) => {
  const [current, setCurrent] = useState(theme);
  return (
    <ThemeProvider theme={current}>
      <Chat store={store} setTheme={setCurrent} />
    </ThemeProvider>
  );
};
