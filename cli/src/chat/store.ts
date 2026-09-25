import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { connect } = require("../../lib/client.js") as { connect: (o: object) => Promise<Hub> };
const media = require("../../lib/media.js") as {
  attachment: (file: string) => Omit<Attachment, "token">;
  attachable: (text: string) => string | null;
  clipboardImage: () => string | null;
  copyText: (text: string) => boolean;
  clipboardText: () => string;
  resolvePath: (raw: string) => string;
  upload: (o: { http: string; token: string | null; file: string }) => Promise<Media>;
  saveAs: (o: { http: string; media: Media; dir?: string }) => Promise<string>;
  openFile: (file: string) => boolean;
};
type AudioLike = {
  on: (event: "speaking" | "error" | "info", fn: (x: any) => void) => void;
  startMic: () => boolean;
  stopMic: () => void;
  play: (from: string, data: string) => void;
  close: () => void;
  setDevice: (kind: "input" | "output", name: string | null) => void;
  report: () => string;
  setVolume: (who: string | null, v: number) => void;
  setMicGain: (v: number | null) => void;
  shaper: { gain: number };
};
type Device = { name: string; label: string; default: boolean };
type Volume = { master: number; people: Record<string, number> };
type Devices = { input: string | null; output: string | null; volume?: Volume; micGain?: number | null };
const voice = require("../../lib/voice.js") as {
  Audio: new (o: { send: (data: string) => void; devices?: Devices; volume?: Volume; shape?: { fixedGain: number | null } }) => AudioLike;
  parseVolume: (arg: string, current: number, max?: number) => number | null;
  listDevices: () => { inputs?: Device[]; outputs?: Device[]; error?: string };
  resolveDevice: (arg: string, list: Device[] | null) => { name?: string | null; error?: string };
  loadPrefs: () => Devices;
  savePrefs: (p: Devices) => void;
  tools: () => { rec: [string, string[]] | null };
};

export type Media = { url: string; type: string; size: number; name: string };
export type Attachment = { file: string; name: string; type: string; size: number; token: string };

export type Kind = "agent" | "human" | "system" | "route";
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
/// Someone in the room's call: the mic on or muted, and whether their voice is coming through.
export type Participant = { name: string; mic: boolean; speaking: boolean; since: string };
/// My own place in a call: which room, the mic, and my voice as this machine hears it.
export type MyCall = { room: string; mic: boolean; speaking: boolean };
export type RoomSummary = { room: string; agents: number; online: number; working: number; blocked: number; attention: number };
export type Tone = "dim" | "ok" | "warn" | "error" | "plain";
type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
export type Entry =
  | { id: string; type: "banner" }
  | { id: string; type: "message"; msg: Message; grouped: boolean }
  | { id: string; type: "note"; tone: Tone; text: string; ts: string }
  | { id: string; type: "members"; members: Member[] }
  | { id: string; type: "screen"; name: string; text: string; title?: string }
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
  status: { text: string; tone: Tone } | null; // the line under the input: what just happened,
  // or what the chat is waiting for. Short-lived, and never worth a place in the conversation.
  attachments: Attachment[]; // files whose tokens may be in the draft
  mouse: boolean; // the chat holds the mouse: it draws the selection and handles clicks
  voice: Map<string, Participant>; // who is in this room's call
  call: MyCall | null; // me, when I am in it
};

type Api = Record<string, Record<string, (args?: object) => Promise<any>> & { on: (event: string, fn: (data: any) => void) => void }>;
type Hub = { m: { close: () => void; on: (e: string, fn: () => void) => void }; api: Api; me: { name: string; role: string } };

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
  { name: "save", args: "[n] [dir]", help: "save the latest file sent in the room (n = 2 is the one before) to ~/Downloads" },
  { name: "open", args: "[n]", help: "save the latest file and open it" },
  { name: "voice", args: "[on|off|stats]", help: "join or leave the room's call (or click your name); headphones keep the echo out" },
  { name: "devices", args: "", help: "the mics and speakers here, numbered for /input and /output" },
  { name: "input", args: "[n|name|default]", help: "which mic the call uses; remembered, switches live" },
  { name: "output", args: "[n|name|default]", help: "which speaker or headphones the call plays on; remembered, switches live" },
  { name: "volume", args: "[150%|+|-|<name> 200%]", help: "how loud the call plays, for everyone or one person (up to 400%)" },
  { name: "mic", args: "[150%|+|-|auto]", help: "how loud you are sent: fixed up to 1600%, or auto (levelled)" },
  { name: "mute", args: "", help: "turn your mic off or on again, staying in the call (or click the bars by your name)" },
  { name: "rooms", args: "", help: "all rooms with counts (or ← on an empty line)" },
  { name: "room", args: "<name>", help: "open another room, creating it if it is new" },
  { name: "theme", args: "[name]", help: "switch the colour theme" },
  { name: "mouse", args: "[on|off]", help: "clicking names and message buttons (off by default, so text selects)" },
  { name: "click", args: "", help: "same as ctrl+t: hand the mouse to the terminal, or take it back" },
  { name: "clear", args: "", help: "clear the screen" },
  { name: "help", args: "", help: "keys and commands" },
  { name: "quit", args: "", help: "leave the chat" },
] as const;

export const CONTROL = /^!(cancel|esc|stop|keys|type)\b/;
/// What the hub takes as a room name.
export const ROOM = /^[\w][\w.-]{0,63}$/;

/// One-word state for a member as humans think of it, not the raw hub status.
/// Three words for what a member is: here and busy, here and not, or gone. The server knows
/// more (starting, blocked, a finished turn nobody looked at), and the room's own messages
/// carry that when it matters; the line above the input does not need it.
export const stateOf = (m: Member): "online" | "working" | "offline" => {
  if (!m.connected) return "offline";
  return m.status === "working" ? "working" : "online";
};

let seq = 0;
const id = () => `e${++seq}`;

/// Everything about the room that is not rendering: the hub connection, members, the log
/// of what is on screen, and the actions the composer triggers. React subscribes to it.
export class Store {
  state: State;
  hub: Hub | null = null;
  private listeners = new Set<() => void>();
  private lastMessage: { name: string; ts: number; to?: string } | null = null;
  private states = new Map<string, string>();
  private marks = new Map<string, string>(); // what was last announced about an agent
  onBell: () => void = () => {};
  onQuit: () => void = () => {};
  onTheme: (name: string) => string | null = () => null;
  private imageSeq = 0;
  config: Config;

  constructor({ name, room, config }: { name: string; room: string; config: Config }) {
    this.config = config;
    this.state = { me: { name, role: "?" }, room, url: config.url, members: new Map(), log: [], busy: null, status: null, attachments: [], mouse: process.env["MC_MOUSE"] !== "0", voice: new Map(), call: null };
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

  /// The chat's own word. A result or a hint is said under the input for a moment and gone;
  /// only what needs the reader (a warning, an error, an agent stuck on a question) stays in
  /// the conversation, drawn like "misha joined".
  note(text: string, tone: Tone = "dim"): void {
    if (tone !== "warn" && tone !== "error") return this.setStatus(text, tone === "dim" ? "plain" : tone, 4000);
    this.lastMessage = null;
    this.push({ type: "note", tone, text, ts: new Date().toISOString() });
  }

  setBusy(busy: string | null): void {
    this.set({ busy });
  }

  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /// Say something under the input. `ms` clears it again; without it the line stays until
  /// something else replaces it, which is what a mode like forwarding wants.
  setStatus(text: string | null, tone: Tone = "ok", ms = 0): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.set({ status: text ? { text, tone } : null });
    if (text && ms) this.statusTimer = setTimeout(() => this.set({ status: null }), ms);
  }

  async start(): Promise<void> {
    const { room } = this.state;
    const name = this.state.me.name;
    const hub: Hub = await connect({ url: this.config.url, token: this.config.token, onOpen: () => this.join(true) });
    this.hub = hub;
    this.set({ me: { name, role: hub.me.role } });
    try {
      await this.join(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/belongs to another token/.test(msg)) {
        const env = process.env["MC_TOKEN"] ? " MC_TOKEN is set in this shell and points at an agent token; unset it or run metacom login again." : "";
        throw new Error(`${msg}. You signed in with a ${hub.me.role} token, and only an owner token can take a name over.${env} Otherwise pick another name with -n.`);
      }
      throw error;
    }
    hub.api.room.on("message", (m: Message) => this.onMessage(m));
    hub.api.agents.on("changed", ({ members }: { members: Member[] }) => this.onMembers(members));
    hub.api.agents.on("message", (m: Message) => {
      if (m.from && m.from.name !== name) this.onBell();
    });
    if (hub.api.voice) {
      hub.api.voice.on("changed", (s: { room: string; participants: Participant[] }) => this.onVoice(s.room, s.participants));
      hub.api.voice.on("frame", (f: { room: string; from: string; data: string }) => {
        if (this.audio && this.state.call && f.room === this.state.call.room) this.audio.play(f.from, f.data);
      });
    }
    hub.m.on("close", () => this.setBusy("reconnecting…"));
    hub.m.on("open", () => this.setBusy(null));
    this.push({ type: "banner" });
    await this.load();
  }

  /// The room's recent history and its members, into an empty log.
  private async load(): Promise<void> {
    const hub = this.hub!;
    const history: Message[] = await hub.api.room.history({ room: this.state.room, limit: 30 });
    this.onMembers(await hub.api.agents.list({}));
    if (hub.api.voice) {
      const calls: { room: string; participants: Participant[] }[] = await hub.api.voice.calls({}).catch(() => []);
      const here = calls.find((c) => c.room === this.state.room);
      this.onVoice(this.state.room, here ? here.participants : []);
    }
    for (const m of history) this.push({ type: "message", msg: m, grouped: this.group(m) });
    if (history.length) this.push({ type: "rule", text: "now" });
  }

  /// Every room on the hub, for the room list (← on an empty line).
  async rooms(): Promise<RoomSummary[]> {
    return this.hub ? this.hub.api.room.list({}) : [];
  }

  /// Move to another room, creating it if nobody has used the name yet: the member follows,
  /// the conversation is replaced by that room's.
  async switchRoom(room: string): Promise<boolean> {
    if (!this.hub || room === this.state.room) return true;
    if (!ROOM.test(room)) {
      this.note("a room name is letters, digits, dot, dash or underscore", "warn");
      return false;
    }
    const was = this.state.room;
    // a call belongs to its room: moving on hangs up, like walking out of the room would
    if (this.state.call) await this.leaveCall(true);
    this.set({ room, log: [], members: new Map(), voice: new Map() });
    this.lastMessage = null;
    this.states.clear();
    this.marks.clear();
    try {
      await this.join(false);
      await this.load();
      return true;
    } catch (error) {
      this.set({ room: was, log: [] });
      await this.join(false).catch(() => {});
      await this.load().catch(() => {});
      this.note(`could not open ${room}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  }

  private async join(again: boolean): Promise<void> {
    const hub = this.hub!;
    const { room } = this.state;
    const name = this.state.me.name;
    const kind = hub.me.role === "owner" ? "human" : "agent";
    await hub.api.agents.register({ name, room, kind, host: os.hostname() });
    if (kind === "human") await hub.api.room.join({ room });
    await hub.api.agents.status({ status: "waiting" });
    // after a reconnect the hub has forgotten the call this window was in
    const call = this.state.call;
    if (again && call && hub.api.voice) await hub.api.voice.join({ room: call.room, mic: call.mic }).catch(() => {});
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
      if (m.kind !== "agent") continue;
      // The line above the input says only online, working or offline. An agent stuck on a
      // question still has to reach the reader, so that arrives in the conversation instead.
      const stuck = m.status === "blocked";
      if (stuck && this.marks.get(m.name) !== "blocked") {
        this.note(`${m.name} needs you${m.reason ? ": " + m.reason : ""}`, "warn");
        this.onBell();
      }
      this.marks.set(m.name, stuck ? "blocked" : "");
      if (!was || was === state) continue;
    }
  }

  // MARK: calls

  private audio: AudioLike | null = null;

  private onVoice(room: string, list: Participant[]): void {
    if (room !== this.state.room) return;
    const before = this.state.voice;
    const voice = new Map(list.map((p) => [p.name, p]));
    this.set({ voice });
    const me = this.state.me.name;
    const joined = list.filter((p) => !before.has(p.name) && p.name !== me).map((p) => p.name);
    const left = [...before.keys()].filter((n) => !voice.has(n) && n !== me);
    if (joined.length) this.setStatus(`${joined.join(", ")} joined the call`, "ok", 3000);
    else if (left.length) this.setStatus(`${left.join(", ")} left the call`, "plain", 3000);
  }

  /// Anyone talking, me included: the chat keeps its animation tick running for the bars.
  get talking(): boolean {
    return Boolean(this.state.call?.speaking) || [...this.state.voice.values()].some((p) => p.speaking && p.name !== this.state.me.name);
  }

  /// Join this room's call with the mic on. The recorder starts here; the player when the
  /// first voice arrives.
  async joinCall(): Promise<void> {
    const api = this.hub?.api;
    if (!api?.voice) return this.note("this hub has no calls yet · update and restart it", "warn");
    const room = this.state.room;
    const rec = voice.tools().rec;
    await api.voice.join({ room, mic: true, tool: rec ? rec[0] + " " + rec[1].join(" ") : "none" });
    const audio = new voice.Audio({
      send: (data) => {
        api.voice!.frame({ data }).catch(() => {});
      },
      devices: voice.loadPrefs(),
      volume: voice.loadPrefs().volume,
      shape: { fixedGain: voice.loadPrefs().micGain ?? null },
    });
    audio.on("speaking", (on: boolean) => {
      if (this.state.call) this.set({ call: { ...this.state.call, speaking: on } });
    });
    audio.on("error", (msg: string) => this.note(`call: ${msg}`, "warn"));
    audio.on("info", (msg: string) => this.setStatus(`call: ${msg}`, "plain", 5000));
    this.audio = audio;
    this.set({ call: { room, mic: true, speaking: false } });
    const mic = audio.startMic();
    this.setStatus(mic ? `joined the call in ${room} · /mute or click the bars to mute · /voice off to leave` : `joined the call in ${room}, listening only`, "ok", 4000);
    if (!mic) await this.setMic(false, true);
  }

  async leaveCall(quiet = false): Promise<void> {
    this.audio?.close();
    this.audio = null;
    const was = this.state.call;
    this.set({ call: null });
    if (!was) return;
    await this.hub?.api.voice?.leave({}).catch(() => {});
    if (!quiet) this.setStatus(`left the ${was.room} call`, "plain", 2500);
  }

  async setMic(on: boolean, quiet = false): Promise<void> {
    const call = this.state.call;
    if (!call) return this.note("not in a call · /voice joins this room's", "warn");
    if (on && this.audio && !this.audio.startMic()) return;
    if (!on) this.audio?.stopMic();
    this.set({ call: { ...call, mic: on, speaking: false } });
    await this.hub!.api.voice!.mic({ on });
    if (!quiet) this.setStatus(on ? "mic on" : "muted · you still hear the room", "ok", 2500);
  }

  /// What clicking your own name does: in or out of the call.
  async toggleCall(): Promise<void> {
    try {
      if (this.state.call) await this.leaveCall();
      else await this.joinCall();
    } catch (error) {
      this.failure(error);
    }
  }

  /// What clicking the bars by your name does.
  async toggleMic(): Promise<void> {
    try {
      if (!this.state.call) await this.joinCall();
      else await this.setMic(!this.state.call.mic);
    } catch (error) {
      this.failure(error);
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

  /// False when the hub refused it, so the app can give the draft back.
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
      else if (t.startsWith(">")) await this.dispatch(t.slice(1).trim());
      else if (CONTROL.test(t)) this.note("control commands go to an agent, e.g. @Alex !cancel", "warn");
      else await this.hub!.api.room.say({ room: this.state.room, text: t, media: await this.uploadAll(t) });
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

  /// Put text on the clipboard, and say so. Where no clipboard tool exists — a server over
  /// ssh — ask the terminal itself with OSC 52, which carries the text back to the machine
  /// you are sitting at.
  copy(text: string): void {
    if (!media.copyText(text)) {
      const payload = Buffer.from(text, "utf8").toString("base64");
      process.stdout.write(`\u001b]52;c;${payload}\u0007`);
    }
    const lines = text.split("\n").length;
    this.setStatus(`copied ${lines} line${lines === 1 ? "" : "s"}`, "ok", 2500);
  }

  /// Clicking on or off. `say` tells the reader what changed; the silent form is the one the
  /// chat uses when it takes the mouse back after a keystroke.
  setMouse(on: boolean, say: boolean): void {
    if (this.state.mouse === on) return;
    this.set({ mouse: on });
    if (!say) return;
    this.note(
      on
        ? "mouse on · drag to select and copy, click names and the ↩ reply / ↪ forward row"
        : "mouse off · the terminal handles the mouse again, as in any other program",
      "ok"
    );
  }


  /// Pass a message on to someone else, under your own name, saying where it came from.
  private forwarded(msg: Message, note: string): string {
    const from = msg.from?.name ?? "?";
    return `[forwarded from ${from}${msg.to ? ` → ${msg.to}` : ""}] ${msg.text}${note ? `\n${note}` : ""}`;
  }

  /// Send a held message on to a member: one of this room's by name, or `member` when it was
  /// picked from another room's list.
  async forward(msg: Message, to: string, note: string, picked?: Member): Promise<void> {
    const body = this.forwarded(msg, note);
    try {
      const member = picked ?? this.state.members.get(to);
      if (!member) return this.setStatus(`nobody called ${to} is here`, "warn", 2500);
      const kind = member.kind === "agent" ? "command" : "info";
      const r = await this.hub!.api.agents.send({ to, text: body, kind, media: msg.media });
      this.setStatus(r.delivered ? `forwarded to ${to}` : `${to} is offline, queued`, "ok", 2500);
    } catch (error) {
      this.failure(error);
    }
  }

  /// Post a held message into another room, for everyone there.
  async forwardToRoom(msg: Message, room: string): Promise<void> {
    try {
      await this.hub!.api.room.say({ room, text: this.forwarded(msg, ""), media: msg.media });
      this.setStatus(`forwarded to ${room}`, "ok", 2500);
    } catch (error) {
      this.failure(error);
    }
  }

  /// The members of any room, for forwarding into it.
  async membersOf(room: string): Promise<Member[]> {
    if (!this.hub) return [];
    const list: Member[] = await this.hub.api.agents.list({ room });
    return list.filter((m) => m.name !== this.state.me.name);
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
    if (to === "auto") return this.dispatch(body);
    const member = this.state.members.get(to);
    if (!member) {
      await this.hub!.api.room.say({ room: this.state.room, text: t });
      this.note(`posted to the room as text (nobody called ${to} is here)`);
      return;
    }
    if (!body) return this.note(`say something after @${to}`, "warn");
    const kind = member.kind === "agent" ? "command" : "info";
    const r = await this.hub!.api.agents.send({ to, text: body, kind, media: await this.uploadAll(body) });
    if (!r.delivered) this.note(`${to} is offline, queued until it is back`);
  }

  private async dispatch(body: string): Promise<void> {
    if (!body) return this.note("say what to do after @auto", "warn");
    const r = await this.hub!.api.agents.dispatch({ text: body, room: this.state.room, media: await this.uploadAll(body) });
    this.note(`the hub picked ${r.agent} (${r.reason})${r.delivered ? "" : ", queued"}`);
  }

  /// `/name args`, also reachable from a key binding.
  async command(t: string): Promise<void> {
    const [cmd, ...rest] = t.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    const api = this.hub!.api;
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
        this.push({ type: "screen", name, text: r.text });
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
        await api.room.say({ room: this.state.room, text: arg, media: await this.uploadAll(arg) });
        break;
      case "attach":
        // handled in the app: the token has to land in the input
        this.note("usage: /attach <path> · or paste a path, or cmd+v an image from the clipboard", "warn");
        break;
      case "save":
      case "open": {
        // `/save 2 ~/tmp`, `/save ~/tmp` or `/open`: files counted from the newest message back
        const n = /^\d+$/.test(rest[0] || "") ? Number(rest.shift()) : 1;
        const all = this.state.log.flatMap((e) => (e.type === "message" && e.msg.media ? e.msg.media : [])).reverse();
        const m = all[n - 1];
        if (!m) return this.note(all.length ? `only ${all.length} file${all.length === 1 ? "" : "s"} in view` : "no files in the room yet", "warn");
        if (cmd === "open") return this.openMedia(m);
        this.note(`saved ${await media.saveAs({ http: this.config.http, media: m, dir: rest.join(" ") || undefined })}`, "ok");
        break;
      }
      case "room":
        if (!arg) return this.note("usage: /room <name> · or ← on an empty line for the list", "warn");
        await this.switchRoom(arg);
        break;
      case "voice":
      case "call": {
        if (/^stats?$/i.test(arg)) {
          if (!this.audio) return this.note("not in a call · /voice joins this room's", "warn");
          this.push({ type: "screen", name: "call", title: "call stats", text: this.audio.report() });
          break;
        }
        const want = arg === "" ? !this.state.call : /^(on|join|yes|1|true)$/i.test(arg);
        if (want && !this.state.call) await this.joinCall();
        else if (!want && this.state.call) await this.leaveCall();
        else this.setStatus(want ? "already in the call" : "not in a call", "plain", 2000);
        break;
      }
      case "devices": {
        const d = voice.listDevices();
        if (d.error) return this.note(d.error, "warn");
        const prefs = voice.loadPrefs();
        const rows = (list: Device[], chosen: string | null) =>
          list.map((x, i) => `  ${chosen === x.name ? "▸" : " "} ${i + 1}. ${x.label}${x.label !== x.name ? `  (${x.name})` : ""}${x.default ? "  · system default" : ""}`);
        const text = [
          `input  (mic)   now: ${prefs.input ?? "system default"}`,
          ...rows(d.inputs ?? [], prefs.input),
          "",
          `output (sound) now: ${prefs.output ?? "system default"}`,
          ...rows(d.outputs ?? [], prefs.output),
          "",
          "/input 2 · /output 3 · /output airpods · /input default",
        ].join("\n");
        this.push({ type: "screen", name: "audio", title: "audio devices", text });
        break;
      }
      case "volume":
      case "vol": {
        const prefs = voice.loadPrefs();
        const vol: Volume = prefs.volume ?? { master: 1, people: {} };
        const pct = (v: number) => `${Math.round(v * 100)}%`;
        if (!arg) {
          const people = Object.entries(vol.people).filter(([, v]) => v !== 1);
          return this.setStatus(`volume ${pct(vol.master)}${people.map(([n, v]) => ` · ${n} ${pct(v)}`).join("")} · /volume 150% · /volume <name> 200%`, "plain", 5000);
        }
        // `/volume 150%`, `/volume +`, or `/volume roma2 200%`
        const [first, second] = rest;
        const who = second !== undefined ? first!.replace(/^@/, "") : null;
        const current = who ? (vol.people[who] ?? 1) : vol.master;
        const v = voice.parseVolume(second ?? first ?? "", current);
        if (v === null) return this.note("usage: /volume 150% · /volume + · /volume - · /volume <name> 200% · /volume reset", "warn");
        if (who) vol.people[who] = v;
        else vol.master = v;
        voice.savePrefs({ ...prefs, volume: vol });
        this.audio?.setVolume(who, v);
        this.setStatus(`${who ? who + "'s " : ""}volume ${pct(v)}${v > 1 ? " · peaks are rounded, not clipped" : ""}`, "ok", 3000);
        break;
      }
      case "mic": {
        const prefs = voice.loadPrefs();
        const pct = (v: number) => `${Math.round(v * 100)}%`;
        const now = this.audio ? ` · gain now ${this.audio.shaper.gain.toFixed(1)}x` : "";
        if (!arg) return this.setStatus(`mic ${prefs.micGain == null ? "auto" : pct(prefs.micGain)}${now} · /mic 150% · /mic + · /mic auto`, "plain", 5000);
        let v: number | null;
        if (/^(auto|reset|default)$/i.test(arg)) v = null;
        else {
          // + and - step from the gain in use, so they work from auto too
          const current = prefs.micGain ?? this.audio?.shaper.gain ?? 1;
          v = voice.parseVolume(arg, current, 16);
          if (v === null) return this.note("usage: /mic 150% · /mic + · /mic - · /mic auto (up to 1600%)", "warn");
        }
        voice.savePrefs({ ...prefs, micGain: v });
        this.audio?.setMicGain(v);
        this.setStatus(v === null ? "mic auto · your voice is levelled for you" : `mic ${pct(v)} fixed · /mic auto to level it again`, "ok", 3500);
        break;
      }
      case "input":
      case "output": {
        const kind = cmd as "input" | "output";
        const prefs = voice.loadPrefs();
        if (!arg) return this.setStatus(`${kind}: ${prefs[kind] ?? "system default"} · /devices lists the others`, "plain", 4000);
        const d = voice.listDevices();
        const list = d.error ? null : (kind === "input" ? d.inputs : d.outputs) ?? null;
        const pick = voice.resolveDevice(arg, list);
        if (pick.error) return this.note(pick.error, "warn");
        const name = pick.name ?? null;
        voice.savePrefs({ ...prefs, [kind]: name });
        this.audio?.setDevice(kind, name);
        const label = name ? (list?.find((x) => x.name === name)?.label ?? name) : "the system default";
        this.setStatus(`${kind === "input" ? "mic" : "sound"}: ${label}${this.audio ? "" : " · used from the next /voice"}`, "ok", 4000);
        break;
      }
      case "mute":
      case "unmute": {
        if (!this.state.call) return this.note("not in a call · /voice joins this room's", "warn");
        await this.setMic(cmd === "unmute" ? true : !this.state.call.mic);
        break;
      }
      case "rooms":
        this.push({ type: "rooms", rooms: await api.room.list({}) });
        break;
      case "theme": {
        const result = this.onTheme(arg);
        if (result) this.note(result, arg ? "ok" : "dim");
        break;
      }
      case "click": {
        this.setMouse(!this.state.mouse, true);
        break;
      }
      case "mouse": {
        const on = arg === "" ? !this.state.mouse : /^(on|yes|1|true)$/i.test(arg);
        this.setMouse(on, true);
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


  /// An attached file, saved to ~/Downloads and opened with the desktop's default app. Used by
  /// /open and by clicking the file's button under a message.
  async openMedia(m: Media): Promise<void> {
    try {
      const file = await media.saveAs({ http: this.config.http, media: m });
      if (media.openFile(file)) this.note(`opened ${file}`, "ok");
      else this.note(`saved ${file}, but could not open it here`, "warn");
    } catch (err) {
      this.note(`${m.name}: ${(err as Error).message}`, "warn");
    }
  }

  quit(): void {
    this.audio?.close();
    this.audio = null;
    try {
      this.hub?.m.close();
    } catch {
      // already closed
    }
    this.onQuit();
  }
}
