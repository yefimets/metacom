import fs from "node:fs";
import { Box, type DOMElement, useApp, useBoxMetrics, useInput, usePaste, useStdout, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ThemeProvider } from "@/providers/theme-provider";
import { useAnimation } from "@/hooks/use-animation";
import { terminalWidth } from "@/lib/terminal-text";
import type { Theme } from "@/components/ui/types";
import { Banner, Help, MemberRows, Rooms, Screen } from "@/chat/components/blocks";
import { Composer, INPUT_ROWS, layout } from "@/chat/components/composer";
import { Footer } from "@/chat/components/footer";
import { SPIN_INTERVAL } from "@/chat/components/glyph";
import { MessageLine, actionAt, type Action } from "@/chat/components/message";
import { Note, Rule } from "@/chat/components/note";
import { Popup, type PopupItem, type PopupState } from "@/chat/components/popup";
import { StatusBar, segments } from "@/chat/components/status-bar";
import { Editor } from "@/chat/editor";
import { COMMANDS, type Entry, type Member, type Message, type Store } from "@/chat/store";
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

/// Enter with a modifier, in the forms that carry the modifier: the kitty protocol's CSI u and
/// xterm's modifyOtherKeys, which ink does not recognise and would type out. The number is
/// 1 + the modifier bits, shift being 1. Read from the raw bytes before ink sees them.
const MODIFIED_ENTER = /\u001b\[(?:13|10);(\d+)(?::\d+)?u|\u001b\[27;(\d+);(?:13|10)~/;

/// SGR mouse reporting (button press only) and the cursor-position report used to find where
/// the status line is on screen. Both are written by the terminal, never typed by a person.
const ALT_ON = "\u001b[?1049h\u001b[H";
const ALT_OFF = "\u001b[?1049l";
const WHEEL_LINES = 3;
const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";
const MOUSE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
/// Everything written by the terminal rather than typed, so ink does not put it in the message.
const REPORTS = /\u001b\[<\d+;\d+;\d+[Mm]/g;

/// Where a laid-out node sits on the screen: yoga positions are relative to the parent, so
/// add them up to the root. Zero-based.
const screenAt = (node: DOMElement | null | undefined): { left: number; top: number } => {
  let left = 0;
  let top = 0;
  for (let n = node; n?.yogaNode; n = n.parentNode) {
    left += n.yogaNode.getComputedLeft();
    top += n.yogaNode.getComputedTop();
  }
  return { left, top };
};

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
    // the window re-wraps itself; just clear what the old size left behind
    stdout.write("\u001B[2J\u001B[H");
    redraw();
  }, [columns, rows, stdout, redraw]);

  const refresh = useCallback(() => {
    setPopup((p) => computePopup(editor, store.state.members, store.state.me.name, p));
    redraw();
  }, [editor, store, redraw]);

  const submit = useCallback(() => {
    // a message held for forwarding: the line names who it goes to, the rest rides along
    const held = forwardRef.current;
    if (held) {
      const m = editor.text.trim().match(/^@?([^\s]+)\s*([\s\S]*)$/);
      if (!m) return;
      setForward(null);
      forwardRef.current = null;
      void store.forward(held, m[1]!, m[2]!.trim());
      editor.set("");
      setPopup(EMPTY_POPUP);
      toBottom();
      return redraw();
    }
    // /attach <path> puts the file's token into the input instead of sending anything
    const attach = editor.text.match(/^\/attach\s+(.+)$/s);
    if (attach) {
      const token = store.attach(attach[1]!.trim());
      editor.set(token ? token + " " : "");
      setPopup(EMPTY_POPUP);
      return refresh();
    }
    const text = editor.submit();
    setPopup(EMPTY_POPUP);
    toBottom();
    redraw();
    void store.submit(text).then((ok) => {
      // a refused message with files comes back into the input, so the tokens are not lost
      if (ok || editor.text || store.pending(text).length === 0) return;
      editor.set(text);
      refresh();
    });
  }, [editor, store, redraw, refresh]);

  // shift+enter inserts a newline instead of sending; cmd+enter and the rest send. The raw
  // listener runs before ink's, so `handled` tells the key handler below to let that Enter be.
  const handledEnter = useRef(false);
  // what ink will type out of a sequence it does not recognise (xterm's modifyOtherKeys), to
  // be dropped instead of landing in the message
  const swallow = useRef("");
  const popupOpen = useRef(false);
  popupOpen.current = popup.kind !== null;
  // Clicking a name on the status line or in a message header puts @name into the input.
  const mouse = state.mouse;
  const mouseRef = useRef(mouse);
  mouseRef.current = mouse;
  const clickState = useRef<{ room: string; members: Map<string, Member>; me: string; log: Entry[] }>({ room: "", members: new Map(), me: "", log: [] });
  clickState.current = { room: state.room, members: state.members, me: state.me.name, log: state.log };

  // MARK: the scrollback. The conversation lives in a window this draws, not in the terminal's
  // own scrollback, so the input stays pinned at the bottom while the wheel moves the history.
  const [offset, setOffset] = useState(0);
  const follow = useRef(true);
  const contentRef = useRef<DOMElement>(null);
  const viewRef = useRef<DOMElement>(null);
  const content = useBoxMetrics(contentRef);
  const view = useBoxMetrics(viewRef);
  const contentH = content.hasMeasured ? content.height : 0;
  const viewH = view.hasMeasured ? view.height : 0;
  const maxOffset = Math.max(0, contentH - viewH);
  const gap = Math.max(0, viewH - contentH);
  const maxRef = useRef(0);
  maxRef.current = maxOffset;
  const scrollBy = useCallback((lines: number) => {
    setOffset((o) => {
      const next = Math.max(0, Math.min(maxRef.current, o + lines));
      follow.current = next >= maxRef.current;
      return next;
    });
  }, []);
  const toBottom = useCallback(() => {
    follow.current = true;
    setOffset(maxRef.current);
  }, []);
  // new lines arrive: stay at the bottom unless the reader has scrolled away from it
  useEffect(() => {
    if (follow.current) setOffset(maxOffset);
  }, [maxOffset]);
  useEffect(() => {
    stdout.write(ALT_ON);
    return () => {
      stdout.write(ALT_OFF);
    };
  }, [stdout]);
  const liveRef = useRef<DOMElement>(null);
  const live = useBoxMetrics(liveRef);
  useEffect(() => {
    if (!mouse) return;
    stdout.write(MOUSE_ON);
    return () => {
      stdout.write(MOUSE_OFF);
    };
  }, [mouse, stdout]);

  // A message waiting for someone to forward it to: the next name picked is the recipient.
  const [forward, setForward] = useState<Message | null>(null);
  const forwardRef = useRef<Message | null>(null);
  forwardRef.current = forward;
  // Put @name at the start of the input, replacing whoever was addressed there.
  const address = useCallback(
    (name: string) => {
      editor.set(editor.text.replace(/^@\S*\s*/, ""));
      editor.home();
      editor.insert(`@${name} `);
      editor.end();
      refresh();
    },
    [editor, refresh]
  );

  /// The message whose action row was clicked, and which action. The entry's last child is
  /// that row, so the laid-out tree answers both without measuring text.
  const feedAction = useCallback((row: number, col: number): { msg: Message; action: Action } | undefined => {
    const { log } = clickState.current;
    const content = contentRef.current;
    if (!content) return;
    for (const [i, child] of content.childNodes.entries()) {
      const entry = log[i];
      if (entry?.type !== "message" || entry.msg.kind === "system") continue;
      // each entry sits in its own wrapper box; the message box inside it ends with the actions
      const inner = ((child as DOMElement).childNodes[0] as DOMElement | undefined) ?? (child as DOMElement);
      const kids = inner.childNodes as unknown as DOMElement[];
      const actions = kids[kids.length - 1];
      if (!actions?.yogaNode) continue;
      const at = screenAt(actions);
      if (at.top !== row - 1) continue;
      const action = actionAt(col - 1 - at.left);
      if (action) return { msg: entry.msg, action };
    }
    return;
  }, []);

  // A click on a sender or recipient in a message header of the feed. Each log entry is one
  // child of the content box, so the entry's header row is found from the laid-out tree.
  const feedName = useCallback((row: number, col: number): string | undefined => {
    const { log, me } = clickState.current;
    const view = viewRef.current;
    const content = contentRef.current;
    if (!view?.yogaNode || !content) return;
    const y = row - 1;
    const x = col - 1;
    const v = screenAt(view);
    if (y < v.top || y >= v.top + view.yogaNode.getComputedHeight()) return;
    for (const [i, child] of content.childNodes.entries()) {
      const entry = log[i];
      if (entry?.type !== "message" || entry.grouped || entry.msg.kind === "system") continue;
      const line = child.nodeName === "ink-box" ? (child.childNodes[0] as DOMElement | undefined) : undefined;
      if (!line) continue;
      const at = screenAt(line);
      if (at.top !== y) continue;
      const from = entry.msg.from?.name ?? "";
      const fromW = terminalWidth(from);
      const c = x - at.left;
      const name = c >= 0 && c < fromW ? from : entry.msg.to && c >= fromW + 3 && c < fromW + 3 + terminalWidth(entry.msg.to) ? entry.msg.to : undefined;
      return name && name !== me ? name : undefined;
    }
    return;
  }, []);

  const onClick = useCallback(
    (row: number, col: number) => {
      const { room, members: list, me } = clickState.current;
      const act = feedAction(row, col);
      if (act) {
        const { msg, action } = act;
        if (action === "reply") {
          const author = msg.from?.name;
          if (author && author !== me) address(author);
          editor.end();
          editor.insert(`${editor.text && !editor.text.endsWith(" ") ? " " : ""}↩ re "${store.quote(msg)}": `);
          return refresh();
        }
        // forward: hold the message, ask who for, and send it on when the name is picked
        setForward(msg);
        editor.set("@");
        editor.end();
        store.note(`forwarding ${msg.from?.name ?? "?"}'s message — pick who, then enter`, "ok");
        return refresh();
      }
      const name = feedName(row, col);
      if (name) return address(name);
      const dbg = process.env["MC_CLICK_DEBUG"];
      // the status line is the first row of the live area; the terminal counts rows from 1
      const statusRow = screenAt(liveRef.current).top + 1;
      const hit = segments(room, list, me).find((s) => col - 1 >= s.start && col - 1 < s.end);
      if (dbg) fs.appendFileSync(dbg, JSON.stringify({ row, col, statusRow, hit }) + "\n");
      if (!hit || row !== statusRow) return;
      address(hit.name);
    },
    [address, feedAction, feedName, editor, refresh, store]
  );

  useEffect(() => {
    const onData = (data: Buffer | string) => {
      const seq = typeof data === "string" ? data : data.toString("utf8");
      // A chunk can hold several of these (press and release together, a wheel burst): drop
      // every one of them from what ink will type, then act on the first real click or report.
      const reports = seq.match(REPORTS);
      if (reports) {
        swallow.current = reports.join("").replace(/\u001b/g, "");
        setTimeout(() => (swallow.current = ""), 0);
        MOUSE.lastIndex = 0;
        let click: RegExpExecArray | null = null;
        let wheel = 0;
        for (let m = MOUSE.exec(seq); m; m = MOUSE.exec(seq)) {
          const button = Number(m[1]);
          if (m[4] !== "M") continue;
          // 64 is the wheel up, 65 the wheel down; 0 is the left button
          if (button === 64) wheel -= WHEEL_LINES;
          else if (button === 65) wheel += WHEEL_LINES;
          else if (button === 0 && !click) click = m;
        }
        if (wheel) scrollBy(wheel);
        // with clicking off, the reports are still dropped from the input but acted on by nobody
        if (click && mouseRef.current) onClick(Number(click[3]), Number(click[2]));
        return;
      }
      const hit = MODIFIED_ENTER.exec(seq);
      if (!hit) return;
      const shift = ((Number(hit[1] ?? hit[2]) - 1) & 1) === 1;
      // ink reads the kitty form itself; with no shift it is an ordinary enter
      if (!shift && hit[1]) return;
      handledEnter.current = true;
      swallow.current = hit[0].replace(/\u001b/g, "");
      // ink dispatches the same keypress synchronously right after this listener; the flag is
      // consumed there. Clear it on the next tick so a later plain Enter still sends.
      setTimeout(() => {
        handledEnter.current = false;
        swallow.current = "";
      }, 0);
      if (popupOpen.current) return;
      if (!shift) return submit();
      editor.insert("\n");
      refresh();
    };
    process.stdin.prependListener("data", onData);
    return () => {
      process.stdin.off("data", onData);
    };
  }, [editor, refresh, submit, scrollBy, onClick]);

  // A pasted path to an image or document (a file dropped on the terminal) becomes its token.
  usePaste((text) => {
    const token = store.attachPasted(text);
    editor.insert(token ? token + " " : text.replace(/\r\n?/g, "\n"));
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
    // one key to hand the mouse back to the terminal for a moment, to select and copy
    if (key.ctrl && input === "t") return void store.command("/mouse");
    // cmd+v, once the terminal is told to send ^V for it, lands here too: an image on the
    // clipboard becomes an attachment, a path becomes one, anything else is pasted as text.
    if (key.ctrl && input === "v") {
      const insert = store.pasteClipboard();
      if (insert) editor.insert(insert);
      return refresh();
    }
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
    if (key.pageUp || key.pageDown) {
      scrollBy((key.pageUp ? -1 : 1) * Math.max(1, (view.hasMeasured ? view.height : rows) - 2));
      return;
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
    if (key.return && handledEnter.current) {
      handledEnter.current = false;
      return; // the raw listener above already inserted the newline
    }
    // the tail of an unrecognised modified-enter sequence, arriving as ordinary text
    if (swallow.current) {
      if (key.escape) return;
      if (input && swallow.current.startsWith(input)) {
        swallow.current = swallow.current.slice(input.length);
        return;
      }
      swallow.current = "";
    }
    // shift+enter; option+enter and ctrl+j too, for terminals that cannot report shift
    if (input === "\n" || (key.return && (key.shift || key.meta))) {
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
      redraw();
    } else if (key.meta && input === "b") editor.wordLeft();
    else if (key.meta && input === "f") editor.wordRight();
    else if (key.meta && input === "d") editor.deleteWordRight();
    else if (key.ctrl || key.meta || key.pageUp || key.pageDown) return;
    else if (input && !/[\u0000-\u001F\u007F]/.test(input)) editor.insert(input);
    else return;
    refresh();
  });

  const members = state.members;
  // The one spinner tick, at the root: every frame re-renders the tree down to the composer,
  // which keeps Ink placing the terminal cursor (it only does so on renders the composer joins).
  const frame = useAnimation({ intervalMs: SPIN_INTERVAL, isActive: store.working });
  const nameW = useMemo(() => Math.min(14, Math.max(6, ...[...members.values()].map((m) => terminalWidth(m.name)))), [members]);
  const width = Math.max(30, columns - 1);
  const footerRoom = rows - 3 - Math.min(6, editor.lines.length) - 3;
  const pending = store.pending(editor.text);
  return (
    // One row short of the window: Ink 7.1 treats a frame that fills the screen as fullscreen,
    // drops its final newline and then miscounts by a row, so the terminal cursor lands above the
    // input and the bottom line is never cleared before a redraw.
    <Box flexDirection="column" width={columns} height={rows - 1}>
      <Box ref={viewRef} flexGrow={1} flexShrink={1} overflowY="hidden" flexDirection="column">
        {/* short conversation: hug the bottom. long one: the offset scrolls it */}
        <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={gap - offset}>
          {/* one box per entry, so a click can be traced back to its entry */}
          {state.log.map((entry) => (
            <Box key={entry.id} flexDirection="column" flexShrink={0}>
              <EntryView entry={entry} members={members} nameW={nameW} state={state} />
            </Box>
          ))}
        </Box>
      </Box>
      <Box ref={liveRef} flexDirection="column" flexShrink={0}>
        <StatusBar room={state.room} members={members} me={state.me.name} url={state.url} frame={frame} />
        {popup.kind && <Popup popup={popup} room={footerRoom} />}
        <Composer text={editor.text} cursor={editor.cursor} width={width} placeholder={`message ${state.room} · @ for agents · / for commands`} tokens={pending.map((a) => a.token)} origin={live.hasMeasured ? { left: live.left, top: live.top } : undefined} />
        <Footer text={editor.text} busy={state.busy} members={members} room={state.room} attachments={pending.length} frame={frame} />
      </Box>
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
