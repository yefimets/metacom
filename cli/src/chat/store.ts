import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { connect } = require("../../lib/client.js") as { connect: (o: object) => Promise<Hub> };

export type Kind = "agent" | "human" | "system" | "route";
export type Member = {
  name: string;
  kind: Kind;
  room: string;
  repo?: string;
  caps?: string[];
  host?: string;
  command?: string;
  status: string;
  connected: boolean;
  attention: boolean;
  reason: string | null;
};
export type Message = {
  id: string;
  ts: string;
  room: string;
  kind: "say" | "command" | "info" | "control" | "system";
  from: { name: string; role: string; kind: Kind };
  to?: string;
  text: string;
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
  epoch: number; // bumped when the log must be drawn again from scratch (resize, /clear)
};

type Api = Record<string, Record<string, (args?: object) => Promise<any>> & { on: (event: string, fn: (data: any) => void) => void }>;
type Hub = { m: { close: () => void; on: (e: string, fn: () => void) => void }; api: Api; me: { name: string; role: string } };

export type Config = { url: string; token: string | null; agentToken?: string | null; room: string };

export const COMMANDS = [
  { name: "agents", args: "", help: "who is in the room and what they are doing" },
  { name: "read", args: "<name> [lines]", help: "an agent's screen (owner)" },
  { name: "wait", args: "<name>", help: "block until the agent is idle or needs you" },
  { name: "seen", args: "<name>", help: "clear the done badge" },
  { name: "cancel", args: "<name>", help: "send Esc to the agent" },
  { name: "keys", args: "<name> enter|esc|up|down|y", help: "press keys in the agent" },
  { name: "say", args: "<text>", help: "post to the room even if it starts with @ or /" },
  { name: "rooms", args: "", help: "all rooms with counts" },
  { name: "theme", args: "[name]", help: "switch the colour theme" },
  { name: "clear", args: "", help: "clear the screen" },
  { name: "help", args: "", help: "keys and commands" },
  { name: "quit", args: "", help: "leave the chat" },
] as const;

export const CONTROL = /^!(cancel|esc|stop|keys|type)\b/;

/// One-word state for a member as humans think of it, not the raw hub status.
export const stateOf = (m: Member): string => {
  if (!m.connected) return "offline";
  if (m.kind === "human") return "online";
  if (m.status === "blocked") return "blocked";
  if (m.attention) return "done";
  return m.status;
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
  onBell: () => void = () => {};
  onQuit: () => void = () => {};
  onTheme: (name: string) => string | null = () => null;
  config: Config;

  constructor({ name, room, config }: { name: string; room: string; config: Config }) {
    this.config = config;
    this.state = { me: { name, role: "?" }, room, url: config.url, members: new Map(), log: [], busy: null, epoch: 0 };
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
    hub.m.on("close", () => this.setBusy("reconnecting…"));
    hub.m.on("open", () => this.setBusy(null));
    this.push({ type: "banner" });
    const history: Message[] = await hub.api.room.history({ room, limit: 30 });
    this.onMembers(await hub.api.agents.list({}));
    for (const m of history) this.push({ type: "message", msg: m, grouped: this.group(m) });
    if (history.length) this.push({ type: "rule", text: "now" });
  }

  private async join(again: boolean): Promise<void> {
    const hub = this.hub!;
    const { room } = this.state;
    const name = this.state.me.name;
    const kind = hub.me.role === "owner" ? "human" : "agent";
    await hub.api.agents.register({ name, room, kind, host: os.hostname() });
    if (kind === "human") await hub.api.room.join({ room });
    await hub.api.agents.status({ status: "waiting" });
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

  // MARK: actions

  async submit(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    this.setBusy("sending…");
    try {
      if (t.startsWith("/")) await this.command(t);
      else if (t.startsWith("@")) await this.directed(t);
      else if (t.startsWith(">")) await this.dispatch(t.slice(1).trim());
      else if (CONTROL.test(t)) this.note("control commands go to an agent, e.g. @Alex !cancel", "warn");
      else await this.hub!.api.room.say({ room: this.state.room, text: t });
    } catch (error) {
      this.failure(error);
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

  private async directed(t: string): Promise<void> {
    const m = t.match(/^@([^\s]+)\s*([\s\S]*)$/)!;
    const to = m[1]!;
    const body = m[2]!.trim();
    if (to === "auto") return this.dispatch(body);
    const member = this.state.members.get(to);
    if (!member) {
      await this.hub!.api.room.say({ room: this.state.room, text: t });
      this.note(`posted to the room as text (nobody called ${to} is here)`);
      return;
    }
    if (!body) return this.note(`say something after @${to}`, "warn");
    const kind = member.kind === "agent" ? "command" : "info";
    const r = await this.hub!.api.agents.send({ to, text: body, kind });
    if (!r.delivered) this.note(`${to} is offline, queued until it is back`);
  }

  private async dispatch(body: string): Promise<void> {
    if (!body) return this.note("say what to do after @auto", "warn");
    const r = await this.hub!.api.agents.dispatch({ text: body, room: this.state.room });
    this.note(`the hub picked ${r.agent} (${r.reason})${r.delivered ? "" : ", queued"}`);
  }

  private async command(t: string): Promise<void> {
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
        await api.room.say({ room: this.state.room, text: arg });
        break;
      case "rooms":
        this.push({ type: "rooms", rooms: await api.room.list({}) });
        break;
      case "theme": {
        const result = this.onTheme(arg);
        if (result) this.note(result, arg ? "ok" : "dim");
        break;
      }
      case "clear":
        this.set({ log: [], epoch: this.state.epoch + 1 });
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

  /// Draw the recent log again from scratch. Ink's Static tracks items by count, so the log
  /// itself is cut, never a view of it.
  replay(keep: number): void {
    this.lastMessage = null;
    this.set({ log: this.state.log.slice(-keep), epoch: this.state.epoch + 1 });
  }

  quit(): void {
    try {
      this.hub?.m.close();
    } catch {
      // already closed
    }
    this.onQuit();
  }
}
