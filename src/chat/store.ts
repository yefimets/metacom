import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { connect } = require("../../lib/client.js") as { connect: (o: object) => Promise<Connection> };
const media = require("../../lib/media.js") as {
  attachment: (file: string) => Omit<Attachment, "token">;
  attachable: (text: string) => string | null;
  clipboardImage: () => string | null;
  clipboardText: () => string;
  resolvePath: (raw: string) => string;
  upload: (o: { http: string; token: string | null; file: string }) => Promise<Media>;
};

export type Media = { url: string; type: string; size: number; name: string };
export type Attachment = { file: string; name: string; type: string; size: number; token: string };

export type Kind = "agent" | "human" | "system";
export type Member = {
  name: string;
  kind: Kind;
  room: string;
  repo?: string;
  caps?: string[];
  host?: string;
  command?: string;
  accept?: "owner" | "any" | string[];
  status: string;
  connected: boolean;
  attention: boolean;
  reason: string | null;
  lastSeen?: string; // when the server last heard from it: the status line puts the freshest first
};
export type Message = {
  id: string;
  ts: string;
  room: string;
  kind: "say" | "command" | "info" | "control" | "system";
  from: { name: string; role: string; kind: Kind };
  to?: string;
  text: string;
  media?: Media[];
};
export type RoomSummary = { room: string; agents: number; online: number; working: number; blocked: number; attention: number };
export type Tone = "dim" | "ok" | "warn" | "error" | "plain";
type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
export type Entry =
  | { id: string; type: "banner" }
  | { id: string; type: "message"; msg: Message; grouped: boolean }
  | { id: string; type: "note"; tone: Tone; text: string }
  | { id: string; type: "members"; members: Member[] }
  | { id: string; type: "screen"; name: string; text: string }
  | { id: string; type: "rooms"; rooms: RoomSummary[] }
  | { id: string; type: "help" }
  | { id: string; type: "rule"; text: string };

export type State = {
  me: { name: string; role: string };
  room: string;
  url: string;
  members: Map<string, Member>;
  log: Entry[];
  busy: string | null;
  attachments: Attachment[]; // files whose tokens may be in the draft
  mouse: boolean; // clicking a name on the status line addresses it (off: the terminal keeps selection)
};

type Api = Record<string, Record<string, (args?: object) => Promise<any>> & { on: (event: string, fn: (data: any) => void) => void }>;
type Rooms = {
  open: (room: string, text: string) => Promise<string>;
  close: (room: string, text: string) => Promise<string>;
  share: (room: string, opts?: { also?: string[]; create?: boolean }) => Promise<{ room: string; shared: number; devices: number }>;
  key: (room: string) => Promise<{ encrypted: boolean; key: string | null }>;
};
type Connection = { m: { close: () => void; on: (e: string, fn: () => void) => void }; api: Api; me: { name: string; role: string }; rooms: Rooms };

export type Config = { url: string; http: string; token: string | null; agentToken?: string | null; room: string };

export const COMMANDS = [
  { name: "agents", args: "", help: "who is in the room and what they are doing" },
  { name: "read", args: "<name> [lines]", help: "an agent's screen (owner)" },
  { name: "wait", args: "<name>", help: "block until the agent is idle or needs you" },
  { name: "seen", args: "<name>", help: "clear the done badge" },
  { name: "cancel", args: "<name>", help: "send Esc to the agent" },
  { name: "keys", args: "<name> enter|esc|up|down|y", help: "press keys in the agent" },
  { name: "say", args: "<text>", help: "post to the room even if it starts with @ or /" },
  { name: "attach", args: "<path>", help: "put a file into the message (or paste a path, or cmd+v an image)" },
  { name: "rooms", args: "", help: "all rooms with counts" },
  { name: "theme", args: "[name]", help: "switch the colour theme" },
  { name: "mouse", args: "[on|off]", help: "click a name on the status line to address it" },
  { name: "clear", args: "", help: "clear the screen" },
  { name: "help", args: "", help: "keys and commands" },
  { name: "quit", args: "", help: "leave the chat" },
] as const;

export const CONTROL = /^!(cancel|esc|stop|keys|type)\b/;

/// One-word state for a member as humans think of it, not the raw metacom status.
export const stateOf = (m: Member): string => {
  if (!m.connected) return "offline";
  if (m.kind === "human") return "online";
  if (m.status === "blocked") return "blocked";
  if (m.attention) return "done";
  return m.status;
};

let seq = 0;
const id = () => `e${++seq}`;

/// Everything about the room that is not rendering: the metacom connection, members, the log
/// of what is on screen, and the actions the composer triggers. React subscribes to it.
export class Store {
  state: State;
  mc: Connection | null = null;
  private listeners = new Set<() => void>();
  private lastMessage: { name: string; ts: number; to?: string } | null = null;
  private states = new Map<string, string>();
  onBell: () => void = () => {};
  onQuit: () => void = () => {};
  onTheme: (name: string) => string | null = () => null;
  private imageSeq = 0;
  config: Config;

  constructor({ name, room, config }: { name: string; room: string; config: Config }) {
    this.config = config;
    this.state = { me: { name, role: "?" }, room, url: config.url, members: new Map(), log: [], busy: null, attachments: [], mouse: process.env["MC_MOUSE"] !== "0" };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): State => this.state;

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  push(entry: Distribute<Entry>): void {
    const log = [...this.state.log, { ...entry, id: id() } as Entry];
    this.set({ log: log.length > 500 ? log.slice(-400) : log });
  }

  note(text: string, tone: Tone = "dim"): void {
    this.lastMessage = null;
    this.push({ type: "note", tone, text });
  }

  setBusy(busy: string | null): void {
    this.set({ busy });
  }

  async start(): Promise<void> {
    const { room } = this.state;
    const name = this.state.me.name;
    const mc: Connection = await connect({ url: this.config.url, token: this.config.token, onOpen: () => this.join(true) });
    this.mc = mc;
    this.set({ me: { name, role: mc.me.role } });
    try {
      await this.join(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/belongs to another token/.test(msg)) {
        const env = process.env["MC_TOKEN"] ? " MC_TOKEN is set in this shell and points at an agent token; unset it or run metacom login again." : "";
        throw new Error(`${msg}. You signed in with a ${mc.me.role} token, and only an owner token can take a name over.${env} Otherwise pick another name with -n.`);
      }
      throw error;
    }
    mc.api.room.on("message", (m: Message) => this.opened(m).then((o) => this.onMessage(o)));
    // an owner device shares the room key with devices that joined since; keys/changed re-checks
    const share = () => {
      if (mc.me.role === "owner") mc.rooms.share(room).catch(() => {});
    };
    mc.api.keys?.on("changed", share); // absent on a server without encrypted rooms
    mc.api.agents.on("changed", share);
    mc.api.agents.on("changed", ({ members }: { members: Member[] }) => this.onMembers(members));
    mc.api.agents.on("message", (m: Message) => {
      if (m.from && m.from.name !== name) this.onBell();
    });
    mc.m.on("close", () => this.setBusy("reconnecting…"));
    mc.m.on("open", () => this.setBusy(null));
    this.push({ type: "banner" });
    const history: Message[] = await mc.api.room.history({ room, limit: 30 });
    this.onMembers(await mc.api.agents.list({}));
    for (const m of history) this.push({ type: "message", msg: await this.opened(m), grouped: this.group(m) });
    if (history.length) this.push({ type: "rule", text: "now" });
    share();
    const { encrypted, key } = await mc.rooms.key(room);
    if (encrypted) this.note(key ? "room is encrypted; this device holds the key" : "room is encrypted and this device has no key yet: an owner device shares it when it comes online", key ? "ok" : "warn");
  }

  /// A message with its text in the clear, when this device holds the room key.
  private async opened(m: Message): Promise<Message> {
    if (!m.text) return m;
    return { ...m, text: await this.mc!.rooms.open(m.room || this.state.room, m.text) };
  }

  /// What goes on the wire for a member's room.
  private async sealed(text: string, to?: string): Promise<string> {
    const room = (to && this.state.members.get(to)?.room) || this.state.room;
    return this.mc!.rooms.close(room, text);
  }

  private async join(again: boolean): Promise<void> {
    const mc = this.mc!;
    const { room } = this.state;
    const name = this.state.me.name;
    const kind = mc.me.role === "owner" ? "human" : "agent";
    await mc.api.agents.register({ name, room, kind, host: os.hostname() });
    if (kind === "human") await mc.api.room.join({ room });
    await mc.api.agents.status({ status: "waiting" });
    if (again) this.note("reconnected", "ok");
  }

  /// Consecutive messages from one sender within two minutes drop the repeated time and name.
  private group(m: Message): boolean {
    if (m.kind === "system") {
      this.lastMessage = null;
      return false;
    }
    const from = m.from?.name ?? "?";
    const ts = Date.parse(m.ts);
    const grouped = Boolean(this.lastMessage && this.lastMessage.name === from && !m.to && !this.lastMessage.to && ts - this.lastMessage.ts < 120_000);
    this.lastMessage = { name: from, ts, to: m.to };
    return grouped;
  }

  private onMessage(m: Message): void {
    const { room, me } = this.state;
    if (m.room && m.room !== room) return;
    this.push({ type: "message", msg: m, grouped: this.group(m) });
    if (m.from && m.from.name !== me.name && m.kind === "say" && new RegExp(`@${me.name}\\b`, "i").test(m.text)) this.onBell();
  }

  private onMembers(list: Member[]): void {
    const { room } = this.state;
    const members = new Map<string, Member>();
    for (const m of list) if (m.room === room) members.set(m.name, m);
    const before = new Map(this.states);
    this.set({ members });
    for (const m of members.values()) {
      const state = stateOf(m);
      const was = before.get(m.name);
      this.states.set(m.name, state);
      if (m.kind !== "agent" || !was || was === state) continue;
      if (state === "blocked") {
        this.note(`${m.name} needs you${m.reason ? ": " + m.reason : ""}  ·  /read ${m.name}, then @${m.name} !keys y or @${m.name} !cancel`, "warn");
        this.onBell();
      } else if (state === "done") {
        this.note(`${m.name} finished  ·  /read ${m.name}`, "ok");
      }
    }
  }

  get working(): boolean {
    return Boolean(this.state.busy) || [...this.state.members.values()].some((m) => m.kind === "agent" && stateOf(m) === "working");
  }

  // MARK: attachments

  /// Attach a file to the draft: it gets a `[image 2.png]`-style token that the caller puts
  /// into the input text; the file is sent only if the token is still there on enter.
  /// Sources: cmd+v or ctrl+v (the clipboard image), a pasted file path, /attach <path>.
  attach(file: string, label?: string): string | null {
    try {
      const a = media.attachment(media.resolvePath(file));
      const known = this.state.attachments.find((x) => x.file === a.file);
      if (known) return known.token;
      if (this.state.attachments.length >= 8) {
        this.note("at most 8 files per message", "warn");
        return null;
      }
      const name = label ?? a.name;
      const token = `[${name}]`;
      this.set({ attachments: [...this.state.attachments, { ...a, name, token }] });
      return token;
    } catch (error) {
      this.failure(error);
      return null;
    }
  }

  /// A pasted line that is a path to a sendable file becomes an attachment instead of text.
  attachPasted(text: string): string | null {
    const file = media.attachable(text);
    return file ? this.attach(file) : null;
  }

  /// Whatever is on the clipboard, as the text to put into the input: an image becomes an
  /// attachment token, a path becomes one too, anything else is pasted as it is.
  pasteClipboard(): string | null {
    const file = media.clipboardImage();
    if (file) {
      const token = this.attach(file, `image ${++this.imageSeq}.png`);
      return token ? token + " " : null;
    }
    const text = media.clipboardText();
    if (!text) {
      this.note("nothing on the clipboard · /attach <path> sends a file", "warn");
      return null;
    }
    const token = this.attachPasted(text.trim());
    return token ? token + " " : text.replace(/\r\n?/g, "\n");
  }

  /// The attachments whose tokens are in the text, in text order.
  pending(text: string): Attachment[] {
    return this.state.attachments.filter((a) => text.includes(a.token)).sort((a, b) => text.indexOf(a.token) - text.indexOf(b.token));
  }

  /// Forget attachments whose tokens are gone from the text (all of them after a send).
  prune(text = ""): void {
    const keep = this.state.attachments.filter((a) => text.includes(a.token));
    if (keep.length !== this.state.attachments.length) this.set({ attachments: keep });
  }

  private async uploadAll(text: string): Promise<Media[] | undefined> {
    const list = this.pending(text);
    if (list.length === 0) return undefined;
    const out: Media[] = [];
    for (const a of list) {
      this.setBusy(`uploading ${a.name}…`);
      out.push({ ...(await media.upload({ http: this.config.http, token: this.config.token, file: a.file })), name: a.name });
    }
    return out;
  }

  // MARK: actions

  /// False when metacom refused it, so the app can give the draft back.
  async submit(text: string): Promise<boolean> {
    const t = text.trim();
    if (!t) {
      this.prune();
      return true;
    }
    this.setBusy("sending…");
    try {
      if (t.startsWith("/")) await this.command(t);
      else if (this.mentioned(t)) await this.directed(t);
      else if (CONTROL.test(t)) this.note("control commands go to an agent, e.g. @Alex !cancel", "warn");
      else await this.mc!.api.room.say({ room: this.state.room, text: await this.sealed(t), media: await this.uploadAll(t) });
      this.prune();
      return true;
    } catch (error) {
      this.failure(error);
      return false;
    } finally {
      this.setBusy(null);
    }
  }

  private failure(error: unknown): void {
    let msg = error instanceof Error ? error.message : String(error);
    const blocked = msg.match(/^(\S+) is blocked on a question/);
    if (blocked) msg = `${blocked[1]} is blocked on a question · /read ${blocked[1]} to see it, then @${blocked[1]} !keys y or @${blocked[1]} !cancel`;
    if (/^Owners only/.test(msg)) msg = "owners only · your token has the agent role";
    this.note(msg, "error");
  }

  /// A short quote of a message, for a reply or a reaction to carry.
  quote(m: Message, max = 60): string {
    return this.snippet(m, max);
  }

  private snippet(m: Message, max = 60): string {
    const one = (m.text || "").replace(/\s+/g, " ").trim();
    return one.length > max ? one.slice(0, max - 1) + "…" : one;
  }

  /// Pass a message on to someone else, under your own name, saying where it came from.
  async forward(msg: Message, to: string, note: string): Promise<void> {
    const from = msg.from?.name ?? "?";
    const body = `↪ [forwarded from ${from}${msg.to ? ` → ${msg.to}` : ""}] ${msg.text}${note ? `\n${note}` : ""}`;
    try {
      const member = this.state.members.get(to);
      if (!member) return this.note(`nobody called ${to} is here`, "warn");
      const kind = member.kind === "agent" ? "command" : "info";
      const r = await this.mc!.api.agents.send({ to, text: body, kind, media: msg.media });
      this.note(r.delivered ? `forwarded to ${to}` : `${to} is offline, queued`, "ok");
    } catch (error) {
      this.failure(error);
    }
  }

  /// The member a message is for: the first @name in it, wherever it stands. A leading
  /// mention is the address and comes off the text; one in the middle of a sentence is part
  /// of what you wrote, so the whole line travels.
  private mentioned(t: string): string | null {
    for (const m of t.matchAll(/(^|\s)@([^\s]+)/g)) {
      const name = m[2]!.replace(/[.,:;!?]+$/, "");
      if (this.state.members.has(name)) return name;
    }
    return t.startsWith("@") ? t.slice(1).split(/\s/)[0]! : null;
  }

  private async directed(t: string): Promise<void> {
    const to = this.mentioned(t)!;
    const lead = t.match(new RegExp(`^@${to.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*([\\s\\S]*)$`));
    const body = lead ? lead[1]!.trim() : t;
    const member = this.state.members.get(to);
    if (!member) {
      await this.mc!.api.room.say({ room: this.state.room, text: await this.sealed(t) });
      this.note(`posted to the room as text (nobody called ${to} is here)`);
      return;
    }
    if (!body) return this.note(`say something after @${to}`, "warn");
    const kind = member.kind === "agent" ? "command" : "info";
    const r = await this.mc!.api.agents.send({ to, text: await this.sealed(body, to), kind, media: await this.uploadAll(body) });
    if (!r.delivered) this.note(`${to} is offline, queued until it is back`);
  }

  /// `/name args`, also reachable from a key binding.
  async command(t: string): Promise<void> {
    const [cmd, ...rest] = t.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    const api = this.mc!.api;
    switch (cmd) {
      case "help":
        this.push({ type: "help" });
        break;
      case "agents":
      case "who": {
        const members = [...this.state.members.values()];
        if (!members.length) return this.note("nobody here");
        this.push({ type: "members", members });
        break;
      }
      case "read": {
        const [name, n] = rest;
        if (!name) return this.note("usage: /read <name> [lines]", "warn");
        const r = await api.agents.read({ name, lines: Number(n) || 30 });
        this.push({ type: "screen", name, text: await this.mc!.rooms.open(this.state.members.get(name)?.room || this.state.room, r.text) });
        const m = this.state.members.get(name);
        if (m && m.attention && this.state.me.role === "owner") await api.agents.seen({ name });
        break;
      }
      case "wait": {
        const [name] = rest;
        if (!name) return this.note("usage: /wait <name>", "warn");
        this.setBusy(`waiting for ${name}…`);
        const r = await api.agents.wait({ name, timeoutMs: 600_000 });
        this.note(r.timeout ? `still waiting, ${name} is ${r.status}` : `${name} is ${r.status}${r.reason ? " (" + r.reason + ")" : ""}`, r.status === "blocked" ? "warn" : "ok");
        break;
      }
      case "seen": {
        const [name] = rest;
        if (!name) return this.note("usage: /seen <name>", "warn");
        await api.agents.seen({ name });
        break;
      }
      case "cancel": {
        const [name] = rest;
        if (!name) return this.note("usage: /cancel <name>", "warn");
        await api.agents.send({ to: name, text: "!cancel", kind: "command" });
        break;
      }
      case "keys": {
        const [name, ...keys] = rest;
        if (!name || !keys.length) return this.note("usage: /keys <name> enter|esc|up|down|y", "warn");
        await api.agents.send({ to: name, text: `!keys ${keys.join(" ")}`, kind: "command" });
        break;
      }
      case "say":
        if (!arg) return this.note("usage: /say <text>", "warn");
        await api.room.say({ room: this.state.room, text: await this.sealed(arg), media: await this.uploadAll(arg) });
        break;
      case "attach":
        // handled in the app: the token has to land in the input
        this.note("usage: /attach <path> · or paste a path, or cmd+v an image from the clipboard", "warn");
        break;
      case "rooms":
        this.push({ type: "rooms", rooms: await api.room.list({}) });
        break;
      case "theme": {
        const result = this.onTheme(arg);
        if (result) this.note(result, arg ? "ok" : "dim");
        break;
      }
      case "mouse": {
        const on = arg === "" ? !this.state.mouse : /^(on|yes|1|true)$/i.test(arg);
        this.set({ mouse: on });
        this.note(
          on
            ? "mouse on · click names and the ↩ reply / ↪ forward row · hold option (macOS) or shift to select text"
            : "mouse off · selection works as usual again; ctrl+t brings the buttons back",
          "ok"
        );
        break;
      }
      case "clear":
        this.set({ log: [] });
        break;
      case "quit":
      case "q":
      case "exit":
        this.quit();
        break;
      default:
        this.note(`unknown command /${cmd} · /help lists them`, "warn");
    }
  }


  quit(): void {
    try {
      this.mc?.m.close();
    } catch {
      // already closed
    }
    this.onQuit();
  }
}
