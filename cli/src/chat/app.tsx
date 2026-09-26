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
import { MessageLine, actionAt, bodyOf, type Action } from "@/chat/components/message";
import { type Selection, isEmpty, textOf } from "@/chat/selection";
import { bodyTextLines } from "@/chat/markdown";
import { Note, Rule } from "@/chat/components/note";
import { MemberPicker, RoomPicker, memberItems, pickerItems, type PickerItem } from "@/chat/components/rooms";
import { Popup, type PopupItem, type PopupState } from "@/chat/components/popup";
import { StatusBar, segments } from "@/chat/components/status-bar";
import { Editor } from "@/chat/editor";
import { COMMANDS, type Entry, type Media, type Member, type Message, type RoomSummary, type Store } from "@/chat/store";
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
/// Button presses and movement while a button is down (1002), in the SGR encoding (1006):
/// enough to follow a drag, without a report for every idle twitch of the pointer.
const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";
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

/// A joined/left line. They come in runs, and a run reads as one notice, so they sit tight
/// against each other and only the last of them takes the line of air.
const isSystem = (entry?: Entry): boolean => entry?.type === "note" || (entry?.type === "message" && entry.msg.kind === "system");

/// The chat keeps a gutter down its left, so nothing starts hard against the terminal edge.
const GUTTER = 2;

const EntryView = ({ entry, members, nameW, state, width, body, selection }: { entry: Entry; members: Map<string, Member>; nameW: number; state: Store["state"]; width: number; body: { top: number; left: number }; selection: Selection | null }) => {
  switch (entry.type) {
    case "banner":
      return <Banner room={state.room} url={state.url} me={state.me.name} role={state.me.role} />;
    case "message":
      return <MessageLine msg={entry.msg} grouped={entry.grouped} members={members} nameW={nameW} width={width} top={body.top} left={body.left} selection={selection} />;
    case "note":
      return <Note text={entry.text} tone={entry.tone} ts={entry.ts} />;
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
  // The room list, in place of the conversation: ← on an empty line opens it, the input
  // filters it or names a new room, ↑↓ choose, enter or → open, esc or ← go back. While a
  // message is held for forwarding, choosing a room goes on to its members (`room` and
  // `members` set): who there gets it, or everyone.
  type Picker = { rooms: RoomSummary[]; index: number; forward?: boolean; room?: string; members?: Member[] | null };
  const [picker, setPicker] = useState<Picker | null>(null);
  const pickerRef = useRef(picker);
  pickerRef.current = picker;
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
    // in the room list the input is a room name, not a message: no @ or / popup
    setPopup((p) => (pickerRef.current ? EMPTY_POPUP : computePopup(editor, store.state.members, store.state.me.name, p)));
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
      store.setStatus(null);
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
  const clickState = useRef<{ room: string; members: Map<string, Member>; me: string; log: Entry[]; width: number }>({ room: "", members: new Map(), me: "", log: [], width: 80 });
  clickState.current = { room: state.room, members: state.members, me: state.me.name, log: state.log, width: columns - GUTTER };

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

  /// Every body line on screen: its row, its left edge and its text. Read from the laid-out
  /// tree, so it is what the reader can actually see and therefore select.
  const feedLines = useCallback((): { row: number; left: number; text: string }[] => {
    const { log, width } = clickState.current;
    const content = contentRef.current;
    const out: { row: number; left: number; text: string }[] = [];
    if (!content) return out;
    for (const [i, child] of content.childNodes.entries()) {
      const entry = log[i];
      if (entry?.type !== "message" || entry.msg.kind === "system") continue;
      const inner = ((child as DOMElement).childNodes[0] as DOMElement | undefined) ?? (child as DOMElement);
      const kids = inner.childNodes as unknown as DOMElement[];
      const body = kids[kids.length - 2];
      if (!body?.yogaNode) continue;
      const at = screenAt(body);
      bodyTextLines(bodyOf(entry.msg.text), width).forEach((text, n) => out.push({ row: at.top + n + 1, left: at.left, text }));
    }
    return out;
  }, []);

  /// Where each message's body starts on screen, so the lines can draw their own selection.
  const [bodyTops, setBodyTops] = useState<Record<string, { top: number; left: number }>>({});
  useEffect(() => {
    const content = contentRef.current;
    if (!content || pickerRef.current) return;
    const next: Record<string, { top: number; left: number }> = {};
    for (const [i, child] of content.childNodes.entries()) {
      const entry = clickState.current.log[i];
      if (entry?.type !== "message" || entry.msg.kind === "system") continue;
      const inner = ((child as DOMElement).childNodes[0] as DOMElement | undefined) ?? (child as DOMElement);
      const kids = inner.childNodes as unknown as DOMElement[];
      const body = kids[kids.length - 2];
      if (body?.yogaNode) {
        const at = screenAt(body);
        next[entry.id] = { top: at.top + 1, left: at.left };
      }
    }
    setBodyTops((prev) => (Object.keys(next).every((k) => prev[k]?.top === next[k]!.top && prev[k]?.left === next[k]!.left) && Object.keys(prev).length === Object.keys(next).length ? prev : next));
  });

  /// The message whose action row was clicked, and which action. The entry's last child is
  /// that row, so the laid-out tree answers both without measuring text.
  const feedAction = useCallback((row: number, col: number): { msg: Message; action: Action; file?: Media } | undefined => {
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
      const hit = actionAt(col - 1 - at.left, entry.msg.media);
      if (hit) return { msg: entry.msg, ...hit };
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
      if (process.env["MC_CLICK_DEBUG"]) fs.appendFileSync(process.env["MC_CLICK_DEBUG"]!, JSON.stringify({ feedName: entry.msg.from?.name, top: at.top, left: at.left, want: y }) + "\n");
      if (at.top !== y) continue;
      const from = entry.msg.from?.name ?? "";
      const fromW = terminalWidth(from);
      const c = x - at.left;
      const name = c >= 0 && c < fromW ? from : entry.msg.to && c >= fromW + 3 && c < fromW + 3 + terminalWidth(entry.msg.to) ? entry.msg.to : undefined;
      return name && name !== me ? name : undefined;
    }
    return;
  }, []);

  /// A drag over the conversation paints a selection and puts it on the clipboard when the
  /// button comes up — the terminal cannot do it while the chat is listening for clicks, so
  /// the chat does it. A press and release in one cell is a click, not a selection.
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  selectionRef.current = selection;
  const dragging = useRef(false);
  // the press is remembered here as well as in state: the release arrives before React has
  // re-rendered, and reading the old state there would turn a click into a stray selection
  const anchor = useRef<{ row: number; col: number } | null>(null);
  const onPress = useCallback((row: number, col: number) => {
    dragging.current = true;
    anchor.current = { row, col };
    setSelection({ anchor: { row, col }, head: { row, col } });
  }, []);
  const onDrag = useCallback((row: number, col: number) => {
    if (!dragging.current) return;
    setSelection((s) => (s ? { ...s, head: { row, col } } : s));
  }, []);

  const onClick = useCallback(
    (row: number, col: number) => {
      if (pickerRef.current) return;
      const { room, members: list, me } = clickState.current;
      const act = feedAction(row, col);
      if (act) {
        const { msg, action } = act;
        // a file button: save it to ~/Downloads and hand it to the desktop
        if (action === "file" && act.file) {
          void store.openMedia(act.file);
          return refresh();
        }
        if (action === "reply") {
          // address them, and answer this very message: an agent carries on the conversation of
          // its thread, where a plain @name would start it a clean one
          const author = msg.from?.name;
          const who = author && author !== me ? author : msg.to && msg.to !== me ? msg.to : null;
          if (who) address(who);
          store.setReply(msg);
          return refresh();
        }
        // forward: hold the message, ask who for, and send it on when the name is picked
        setForward(msg);
        editor.set("@");
        editor.end();
        store.setStatus(`forwarding ${msg.from?.name ?? "?"}'s message · pick who, or clear the @ and ← for another room · esc cancels`, "ok");
        return refresh();
      }
      const name = feedName(row, col);
      if (name) return address(name);
      const dbg = process.env["MC_CLICK_DEBUG"];
      // the status line is the first row of the live area; the terminal counts rows from 1
      const liveBox = screenAt(liveRef.current);
      const statusRow = liveBox.top + 1;
      const hit = segments(room, list, me).find((s) => col - 1 - liveBox.left >= s.start && col - 1 - liveBox.left < s.end);
      if (dbg) fs.appendFileSync(dbg, JSON.stringify({ row, col, statusRow, hit }) + "\n");
      if (!hit || row !== statusRow) return;
      address(hit.name);
    },
    [address, feedAction, feedName, editor, refresh, store]
  );

  const onRelease = useCallback(
    (row: number, col: number) => {
      dragging.current = false;
      const started = anchor.current;
      anchor.current = null;
      const moved = started && (started.row !== row || started.col !== col);
      if (!moved) {
        setSelection(null);
        return onClick(row, col);
      }
      const done: Selection = { anchor: started!, head: { row, col } };
      setSelection(done);
      const text = textOf(done, feedLines());
      if (text) store.copy(text);
    },
    [onClick, feedLines, store]
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
        let wheel = 0;
        for (let m = MOUSE.exec(seq); m; m = MOUSE.exec(seq)) {
          const button = Number(m[1]);
          const col = Number(m[2]);
          const row = Number(m[3]);
          const pressed = m[4] === "M";
          // 64 and 65 are the wheel; 32 is movement with the left button down; 0 is that button
          if (pressed && button === 64) wheel -= WHEEL_LINES;
          else if (pressed && button === 65) wheel += WHEEL_LINES;
          else if (!mouseRef.current) continue;
          else if (pressed && button === 0) onPress(row, col);
          else if (pressed && button === 32) onDrag(row, col);
          else if (!pressed) onRelease(row, col);
        }
        if (wheel) scrollBy(wheel);
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
  }, [editor, refresh, submit, scrollBy, onPress, onDrag, onRelease]);

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
    // The terminal keeps the mouse by default, so a drag selects text in the feed and in the
    // input as usual. One key lends it to the chat when you want to click, and takes it back.
    if (key.ctrl && input === "t") {
      store.setMouse(!store.state.mouse, true);
      return;
    }
    // cmd+v, once the terminal is told to send ^V for it, lands here too: an image on the
    // clipboard becomes an attachment, a path becomes one, anything else is pasted as text.
    if (key.ctrl && input === "v") {
      const insert = store.pasteClipboard();
      if (insert) editor.insert(insert);
      return refresh();
    }
    if (pickerRef.current) {
      const p = pickerRef.current;
      const items = p.room ? memberItems(p.room, p.members ?? [], editor.text) : pickerItems(p.rooms, editor.text, store.state.room, !p.forward);
      const closePicker = () => {
        setPicker(null);
        // still forwarding: back to picking someone in this room
        editor.set(forwardRef.current ? "@" : "");
        setPopup(EMPTY_POPUP);
        refresh();
      };
      if (key.escape) return closePicker();
      if (key.leftArrow && !editor.text) {
        // from a room's members back to the rooms, with that room chosen
        if (p.room) {
          const back = pickerItems(p.rooms, "", store.state.room, false).findIndex((i) => i.room === p.room);
          setPicker({ rooms: p.rooms, index: Math.max(0, back), forward: true });
          return;
        }
        return closePicker();
      }
      if (key.upArrow || key.downArrow) {
        if (!items.length) return;
        setPicker({ ...p, index: (Math.min(p.index, items.length - 1) + (key.upArrow ? -1 : 1) + items.length) % items.length });
        return;
      }
      if (key.return || (key.rightArrow && editor.cursor >= editor.text.length)) {
        const item: PickerItem | undefined = items[Math.min(p.index, items.length - 1)];
        if (!item) return;
        const held = forwardRef.current;
        if (held && p.room) {
          // the recipient is picked: a member, or the room itself
          setForward(null);
          forwardRef.current = null;
          store.setStatus(null);
          if (item.member) void store.forward(held, item.member.name, "", item.member);
          else void store.forwardToRoom(held, item.room);
          return closePicker();
        }
        if (held) {
          editor.clear();
          setPicker({ ...p, room: item.room, members: null, index: 0 });
          void store.membersOf(item.room).then((members) => setPicker((cur) => (cur && cur.room === item.room ? { ...cur, members } : cur)));
          return;
        }
        closePicker();
        void store.switchRoom(item.room).then(toBottom);
        return;
      }
      // anything else edits the name; the choice goes back to the top of what matches
      if (input && !key.ctrl && !key.meta) setPicker({ ...p, index: 0 });
      if (key.backspace || key.delete) setPicker({ ...p, index: 0 });
    } else if (key.leftArrow && !editor.text && popup.kind === null) {
      setPicker({ rooms: [], index: 0, forward: Boolean(forwardRef.current) });
      void store.rooms().then((rooms) => setPicker((cur) => (cur ? { ...cur, rooms, index: Math.max(0, pickerItems(rooms, "", store.state.room).findIndex((i) => i.room === store.state.room)) } : cur)));
      return;
    }
    if (key.escape) {
      const twice = Date.now() - lastEsc.current < 900;
      lastEsc.current = Date.now();
      // a reply being written goes first: esc makes it a plain message again
      if (store.state.replyTo) {
        store.setReply(null);
        store.setStatus("not a reply any more · a plain @agent starts a clean context", "warn", 2000);
        return refresh();
      }
      // a message held for forwarding goes first: esc puts it down
      if (forwardRef.current) {
        setForward(null);
        forwardRef.current = null;
        editor.set("");
        setPopup(EMPTY_POPUP);
        store.setStatus("forwarding cancelled", "warn", 1500);
        return refresh();
      }
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
  const width = Math.max(30, columns - GUTTER - 1);
  const footerRoom = rows - 3 - Math.min(6, editor.lines.length) - 3;
  const pending = store.pending(editor.text);
  return (
    // One row short of the window: Ink 7.1 treats a frame that fills the screen as fullscreen,
    // drops its final newline and then miscounts by a row, so the terminal cursor lands above the
    // input and the bottom line is never cleared before a redraw.
    <Box flexDirection="column" width={columns} height={rows - 1} paddingLeft={GUTTER}>
      <Box ref={viewRef} flexGrow={1} flexShrink={1} overflowY="hidden" flexDirection="column">
        {/* The conversation is pinned to the bottom of the view and scrolled back by how far the
            reader is above the end. Absolute, so its height is its entries' alone: laid out in
            the flow, a margin that took the free space (an empty log: all of it) squeezed the
            entries that arrived next to zero rows, and a margin that followed the offset fed
            back into the height it was computed from. The room list takes its place while open. */}
        <Box ref={contentRef} position="absolute" left={0} right={0} bottom={picker ? 0 : offset - maxOffset} flexDirection="column" flexShrink={0}>
          {picker && (picker.room ? <MemberPicker room={picker.room} members={picker.members ?? null} filter={editor.text} index={picker.index} height={viewH} /> : <RoomPicker rooms={picker.rooms} filter={editor.text} index={picker.index} current={state.room} height={viewH} />)}
          {/* one box per entry, so a click can be traced back to its entry */}
          {!picker && state.log.map((entry, i) => (
            // a message ends with a line of air, so the action row does not touch what follows;
            // a joined/left line only when the next line is not another one of them
            <Box key={entry.id} flexDirection="column" flexShrink={0} marginBottom={(entry.type === "message" || entry.type === "note") && !(isSystem(entry) && isSystem(state.log[i + 1])) ? 1 : 0}>
              <EntryView entry={entry} members={members} nameW={nameW} state={state} width={columns - GUTTER} body={bodyTops[entry.id] ?? { top: -1000, left: 0 }} selection={selection} />
            </Box>
          ))}
        </Box>
      </Box>
      <Box ref={liveRef} flexDirection="column" flexShrink={0}>
        {/* the member line belongs to the room you are in; the room list stands on its own */}
        {!picker && <StatusBar room={state.room} members={members} me={state.me.name} url={state.url} frame={frame} mouse={state.mouse} />}
        {popup.kind && <Popup popup={popup} room={footerRoom} />}
        <Composer text={editor.text} cursor={editor.cursor} width={width} placeholder={picker ? (picker.room ? "filter · ↑↓ enter sends · ← rooms" : picker.forward ? "filter · ↑↓ enter · esc back" : "filter or new room · ↑↓ enter · esc back") : `message ${state.room} · @ for agents · / for commands · ← rooms`} tokens={pending.map((a) => a.token)} origin={live.hasMeasured ? { left: live.left, top: live.top } : undefined} />
        <Footer text={editor.text} busy={state.busy} status={state.status} members={members} room={state.room} attachments={pending.length} frame={frame} />
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
