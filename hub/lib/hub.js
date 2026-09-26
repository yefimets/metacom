'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ROOM, Store } = require('./store.js');
const { Media } = require('./media.js');
const { route } = require('./router.js');
const { fail } = require('./errors.js');

const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const STATUSES = new Set(['starting', 'working', 'waiting', 'blocked', 'stopped']);
const READY = new Set(['waiting', 'blocked', 'stopped']);
const CONTROL = /^!(cancel|esc|stop|keys|type)\b/;
const READ_TIMEOUT = 5_000;
const TURN_START_TIMEOUT = 10_000;
const KINDS = new Set(['agent', 'human']);
const MAX_TEXT = 16 * 1024;
const RATE_WINDOW = 10_000;
const RATE_CALLS = 200;
const THREADS_KEPT = 5000;

const now = () => new Date().toISOString();

/// Who may type commands into an agent: 'owner', 'any', or a list of agent names.
const acceptOf = (value) => {
  if (Array.isArray(value)) return value.map((n) => String(n).slice(0, 32)).slice(0, 32);
  return value === 'any' ? 'any' : 'owner';
};
const acceptsFrom = (member, sender) => {
  if (sender.record.role === 'owner') return true;
  const accept = member.accept || 'owner';
  if (accept === 'any') return true;
  return Array.isArray(accept) && accept.includes(sender.name);
};
const id = () => crypto.randomUUID();

/// Message text; a message that carries files may have none.
const text = (value, what = 'text', withMedia = false) => {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw fail(400, `${what} must be a string`);
  if (value.trim().length === 0 && !withMedia) throw fail(400, `${what} is required`);
  if (value.length > MAX_TEXT) throw fail(413, `${what} is longer than ${MAX_TEXT} characters`);
  return value;
};

/// Rooms, members and directed messages. A member is an identity (a name) that outlives
/// its process: the wrapper and the MCP bridge of one agent are two connections of one
/// member, and an agent that reconnects from another machine keeps its name and inbox.
/// `events` mirrors what goes to websocket clients ('room/message', 'agents/changed') plus
/// 'agents/attention' when an agent starts needing a look; in-process connectors listen there.
class Hub {
  constructor({ dataDir, auth, console, router = {} }) {
    this.console = console;
    this.events = new EventEmitter();
    this.auth = auth;
    this.router = router;
    this.store = new Store(dataDir);
    this.media = new Media(dataDir);
    this.members = new Map();
    for (const m of this.store.loadJson('members.json', [])) {
      this.members.set(m.name, { ...m, connected: false, status: 'stopped' });
    }
    this.inbox = new Map(Object.entries(this.store.loadJson('inbox.json', {})));
    this.conns = new Map();
    this.byName = new Map();
    this.waiters = new Map();
    this.reads = new Map();
    this.threads = new Map(); // message id -> thread id (the first message of its thread), recent ones
  }

  // MARK: connections

  bind(client, record, ip) {
    const conn = { client, record, ip, name: null, room: record.role === 'owner' ? '*' : null, calls: [] };
    this.conns.set(client, conn);
    client.on('close', () => this.unbind(client));
    return conn;
  }

  unbind(client) {
    const conn = this.conns.get(client);
    if (!conn) return;
    this.conns.delete(client);
    if (!conn.name || conn.follow) return;
    const set = this.byName.get(conn.name);
    if (set) {
      set.delete(client);
      if (set.size > 0) return;
      this.byName.delete(conn.name);
    }
    const member = this.members.get(conn.name);
    if (member && member.connected) {
      member.connected = false;
      member.status = 'stopped';
      member.reason = 'disconnected';
      member.lastSeen = now();
      this.console.log(`hub: ${member.name} disconnected`);
      this.saveMembers();
      this.system(member.room, `${member.name} left`);
      this.settle(member);
      this.changed();
    }
  }

  /// A connection for something living inside the hub process (a connector): it calls
  /// say/send/dispatch/read like a signed-in client, under the role it was given.
  local(name, role = 'owner') {
    return { client: null, record: { id: `local:${name}`, name, role }, ip: 'local', name: null, room: '*', ephemeral: true, calls: [] };
  }

  /// The connection behind a call. Websocket callers signed in earlier; HTTP callers
  /// pass their token with every call and get an ephemeral connection.
  identify(context, args = {}) {
    const bound = this.conns.get(context.client);
    if (bound) {
      this.tick(bound);
      return bound;
    }
    if (args && typeof args.token === 'string') {
      const record = this.auth.verify(args.token);
      if (!record) throw fail(401, 'Bad token');
      return { client: context.client, record, ip: context.client.source, name: null, room: '*', ephemeral: true, calls: [] };
    }
    throw fail(401, 'Sign in first');
  }

  tick(conn) {
    const t = Date.now();
    conn.calls = conn.calls.filter((x) => t - x < RATE_WINDOW);
    conn.calls.push(t);
    if (conn.calls.length > RATE_CALLS) throw fail(429, 'Too many calls');
  }

  owner(conn) {
    if (conn.record.role !== 'owner') throw fail(403, 'Owners only');
  }

  from(conn) {
    const member = conn.name ? this.members.get(conn.name) : null;
    return { name: conn.name || conn.record.name, role: conn.record.role, kind: member ? member.kind : 'human' };
  }

  // MARK: members

  register(conn, info = {}) {
    if (conn.ephemeral) throw fail(400, 'Register over a websocket connection');
    const name = String(info.name || '');
    if (!NAME.test(name)) throw fail(400, 'name: letters, digits, dot, dash, underscore, up to 32');
    if (info.follow) return this.follow(conn, name);
    const kind = info.kind || 'agent';
    if (!KINDS.has(kind)) throw fail(400, 'kind must be agent or human');
    if (kind === 'human' && conn.record.role !== 'owner') throw fail(403, 'Only owner tokens join as humans');
    if (info.room !== undefined && !ROOM.test(String(info.room))) throw fail(400, 'room: letters, digits, dot, dash, underscore, up to 64');
    let member = this.members.get(name);
    if (member && member.tokenId !== conn.record.id && conn.record.role !== 'owner') {
      throw fail(403, `"${name}" belongs to another token`);
    }
    if (!member) {
      member = { name, kind, tokenId: conn.record.id, since: now(), status: 'starting' };
      this.members.set(name, member);
    }
    member.kind = kind;
    if (info.room !== undefined) member.room = String(info.room);
    if (!member.room) member.room = 'default';
    if (info.repo !== undefined) member.repo = info.repo ? String(info.repo).slice(0, 512) : null;
    if (Array.isArray(info.caps)) member.caps = info.caps.map((c) => String(c).slice(0, 32)).slice(0, 32);
    if (info.host !== undefined) member.host = String(info.host).slice(0, 128);
    if (info.accept !== undefined) member.accept = acceptOf(info.accept);
    if (info.command !== undefined) member.command = String(info.command).slice(0, 256);
    const wasConnected = member.connected;
    if (!member.connected) member.status = kind === 'agent' ? 'starting' : 'waiting';
    member.connected = true;
    member.attention = false;
    member.reason = null;
    member.lastSeen = now();
    if (conn.name && conn.name !== name) this.unbind(conn.client);
    conn.name = name;
    conn.room = member.room;
    if (!this.byName.has(name)) this.byName.set(name, new Set());
    this.byName.get(name).add(conn.client);
    this.console.log(`hub: ${name} (${kind}) joined room ${member.room} from ${conn.ip}`);
    this.saveMembers();
    if (!wasConnected) this.system(member.room, `${name} joined${member.host ? ' from ' + member.host : ''}`);
    this.changed();
    return this.publicMember(member);
  }

  /// A companion connection (the MCP bridge inside the agent) speaks as a member its wrapper
  /// registered, but never counts for presence: the member is online while the wrapper is, and a
  /// bridge a background process kept alive after the wrapper exited cannot hold it online.
  follow(conn, name) {
    const member = this.members.get(name);
    if (!member) throw fail(404, `No member named "${name}"; its wrapper registers it`);
    if (member.tokenId !== conn.record.id && conn.record.role !== 'owner') {
      throw fail(403, `"${name}" belongs to another token`);
    }
    if (conn.name && conn.name !== name) this.unbind(conn.client);
    conn.name = name;
    conn.room = member.room;
    conn.follow = true;
    return this.publicMember(member);
  }

  setStatus(conn, status, reason = null) {
    if (!conn.name) throw fail(400, 'Register first');
    if (!STATUSES.has(status)) throw fail(400, `status must be one of ${[...STATUSES].join(', ')}`);
    const member = this.members.get(conn.name);
    member.reason = reason ? String(reason).slice(0, 120) : null;
    if (member.status === status) return this.publicMember(member);
    const before = member.status;
    member.status = status;
    member.lastSeen = now();
    this.console.log(`hub: ${member.name} ${before} -> ${status}${member.reason ? ' (' + member.reason + ')' : ''}`);
    // herdr's "done": finished a turn the owner asked for and nobody has looked yet. Blocked always needs a look.
    if (status === 'blocked') member.attention = true;
    else if (before === 'working' && status === 'waiting' && member.turnPending) {
      member.attention = true;
      member.turnPending = false;
    }
    if (member.attention) this.events.emit('agents/attention', this.publicMember(member));
    this.settle(member);
    this.changed();
    return this.publicMember(member);
  }

  /// Owner looked at the agent: clears the done/blocked badge (herdr's seen state).
  seen(conn, name) {
    this.owner(conn);
    const member = this.members.get(String(name || ''));
    if (!member) throw fail(404, `No agent named "${name}"`);
    member.attention = false;
    this.changed();
    return this.publicMember(member);
  }

  /// Server-owned wait for an agent to reach one of the given statuses (herdr's agent wait).
  wait(conn, name, until = [...READY], timeoutMs = 60_000) {
    const member = this.members.get(String(name || ''));
    if (!member) throw fail(404, `No agent named "${name}"`);
    const wanted = new Set((Array.isArray(until) ? until : [until]).filter((s) => STATUSES.has(s)));
    if (wanted.size === 0) throw fail(400, 'until: list of statuses');
    const started = Date.now();
    const current = member.connected ? member.status : 'stopped';
    if (wanted.has(current)) return Promise.resolve({ name: member.name, status: current, reason: member.reason, elapsedMs: 0 });
    const limit = Math.min(Math.max(Number(timeoutMs) || 60_000, 1_000), 600_000);
    return new Promise((resolve) => {
      const list = this.waiters.get(member.name) || [];
      const entry = { wanted, resolve: null, timer: null };
      entry.resolve = (status) => {
        clearTimeout(entry.timer);
        const remaining = (this.waiters.get(member.name) || []).filter((w) => w !== entry);
        this.waiters.set(member.name, remaining);
        resolve({ name: member.name, status, reason: member.reason, elapsedMs: Date.now() - started, timeout: status === null });
      };
      entry.timer = setTimeout(() => entry.resolve(null), limit);
      list.push(entry);
      this.waiters.set(member.name, list);
    });
  }

  settle(member) {
    const status = member.connected ? member.status : 'stopped';
    for (const w of [...(this.waiters.get(member.name) || [])]) if (w.wanted.has(status)) w.resolve(status);
  }

  /// The agent's screen, asked from its wrapper (herdr's agent read). Owner only: screens hold secrets.
  read(conn, name, lines = 40) {
    this.owner(conn);
    const member = this.members.get(String(name || ''));
    if (!member) throw fail(404, `No agent named "${name}"`);
    const clients = this.byName.get(member.name);
    if (!member.connected || !clients || clients.size === 0) throw fail(409, `${member.name} is offline`);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reads.delete(id);
        reject(fail(504, `${member.name} did not answer the read`));
      }, READ_TIMEOUT);
      this.reads.set(id, { name: member.name, resolve, timer });
      for (const client of clients) this.emit(client, 'agents/readRequest', { id, lines: Math.min(Number(lines) || 40, 500) });
    });
  }

  readReply(conn, id, text) {
    const pending = this.reads.get(id);
    if (!pending) return { accepted: false };
    if (pending.name !== conn.name) throw fail(403, 'Not your read');
    clearTimeout(pending.timer);
    this.reads.delete(id);
    pending.resolve({ name: pending.name, text: String(text ?? '').slice(0, 64_000) });
    return { accepted: true };
  }

  list(conn, room) {
    const all = [...this.members.values()].map((m) => this.publicMember(m));
    const scope = room || (conn.room === '*' ? null : conn.room);
    return scope ? all.filter((m) => m.room === scope) : all;
  }

  publicMember(m) {
    const { name, kind, room, repo, caps = [], host, command, status, connected, since, lastSeen, attention, reason, accept, thread } = m;
    return { name, kind, room, repo, caps, host, command, status, connected: Boolean(connected), since, lastSeen, attention: Boolean(attention), reason: reason || null, accept: kind === 'agent' ? accept || 'owner' : undefined, thread: thread || null };
  }

  saveMembers() {
    const list = [...this.members.values()].map(({ name, kind, tokenId, room, repo, caps, host, command, accept, since, lastSeen }) => ({
      name, kind, tokenId, room, repo, caps, host, command, accept, since, lastSeen,
    }));
    this.store.saveJson('members.json', list);
  }

  // MARK: messages

  join(conn, room) {
    if (conn.ephemeral) throw fail(400, 'Join over a websocket connection');
    conn.room = String(room || '') || '*';
    if (conn.room !== '*' && !ROOM.test(conn.room)) throw fail(400, 'room: letters, digits, dot, dash, underscore, up to 64');
    if (conn.room !== '*' && conn.record.role !== 'owner' && conn.name) {
      const member = this.members.get(conn.name);
      if (member.room !== conn.room) throw fail(403, 'Agents stay in the room they registered in');
    }
    return { room: conn.room };
  }

  // MARK: threads
  //
  // A message that answers another (`replyTo`) belongs to that one's thread; any other message
  // starts a thread of its own. An agent's answers — what it says in the room, notes, replies to
  // whoever gave it the command — join the thread of the command it is working on, so a reply to
  // the answer carries on the same conversation. A command it sends another agent is new work
  // and starts a thread, unless it replies on purpose.

  threadOf(conn, msgId, replyTo, { answer = true, to = null } = {}) {
    if (replyTo) {
      replyTo = String(replyTo).replace(/^#/, '').slice(0, 64);
      // agents see ids shortened to 8 characters (hub_read): the newest message they start
      if (replyTo.length < 36) {
        const full = [...this.threads.keys()].reverse().find((k) => k.startsWith(replyTo));
        if (full) replyTo = full;
      }
      return { replyTo, thread: this.threads.get(replyTo) || replyTo };
    }
    const member = conn.name ? this.members.get(conn.name) : null;
    if (answer && member && member.kind === 'agent' && member.thread && (!to || to === member.threadFrom)) {
      return { replyTo: member.threadMsg, thread: member.thread };
    }
    return { replyTo: null, thread: msgId };
  }

  remember(msg) {
    this.threads.set(msg.id, msg.thread);
    if (this.threads.size > THREADS_KEPT) this.threads.delete(this.threads.keys().next().value);
  }

  say(conn, room, body, media = null, replyTo = null) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    const files = this.media.attachments(media);
    const msg = { id: id(), ts: now(), room: target, kind: 'say', from: this.from(conn), text: text(body, 'text', Boolean(files)) };
    Object.assign(msg, this.threadOf(conn, msg.id, replyTo));
    this.remember(msg);
    if (files) msg.media = files;
    this.store.appendRoom(target, msg);
    this.broadcast('room/message', msg, target);
    return msg;
  }

  async send(conn, to, body, kind = 'command', wait = null, media = null, replyTo = null) {
    const member = this.members.get(String(to || ''));
    if (!member) throw fail(404, `No agent named "${to}"`);
    if (!['command', 'info'].includes(kind)) throw fail(400, 'kind must be command or info');
    const files = this.media.attachments(media);
    body = text(body, 'text', Boolean(files));
    if (kind === 'command' && CONTROL.test(body)) {
      this.owner(conn);
      kind = 'control';
    }
    // A command from an agent the target does not take commands from still arrives, as a note.
    const downgraded = kind === 'command' && !acceptsFrom(member, conn);
    if (downgraded) kind = 'info';
    if (kind === 'command' && member.connected && member.status === 'blocked') {
      throw fail(409, `${member.name} is blocked on a question; answer it (metacom read/!keys) or send !cancel first`);
    }
    const msg = { id: id(), ts: now(), room: member.room, kind, from: this.from(conn), to: member.name, text: body };
    // a command to another agent is new work; notes and answers stay in the sender's thread
    Object.assign(msg, this.threadOf(conn, msg.id, replyTo, { answer: kind !== 'command' || member.kind !== 'agent', to: member.name }));
    this.remember(msg);
    if (kind === 'command') {
      member.thread = msg.thread;
      member.threadMsg = msg.id;
      member.threadFrom = msg.from.name;
    }
    if (files) msg.media = files;
    this.pushInbox(member.name, msg);
    this.store.appendRoom(member.room, msg);
    this.broadcast('room/message', msg, member.room);
    const clients = this.byName.get(member.name) || new Set();
    for (const client of clients) this.emit(client, 'agents/message', msg);
    if (kind === 'command' && conn.record.role === 'owner') member.turnPending = true;
    const result = { id: msg.id, to: member.name, kind, delivered: clients.size > 0, queued: !clients.size };
    if (downgraded) result.downgraded = true;
    if (wait && result.delivered && kind === 'command') result.turn = await this.observeTurn(member, wait);
    return result;
  }

  /// After a command: expect the agent to start working within a few seconds, then settle
  /// (herdr's prompt --wait, including its "stalled" outcome when nothing happened).
  async observeTurn(member, wait) {
    const until = Array.isArray(wait.until) && wait.until.length ? wait.until : [...READY];
    const timeoutMs = Number(wait.timeoutMs) || 120_000;
    if (member.status === 'starting') {
      const ready = await this.wait(null, member.name, ['waiting', 'working', 'blocked', 'stopped'], 60_000);
      if (ready.timeout) return { status: member.status, stalled: true };
    }
    if (member.status !== 'working') {
      const started = await this.wait(null, member.name, ['working', 'blocked', 'stopped'], TURN_START_TIMEOUT);
      if (started.timeout) return { status: member.status, stalled: true };
      if (started.status !== 'working') return { status: started.status, stalled: false };
    }
    const done = await this.wait(null, member.name, until, timeoutMs);
    return { status: done.timeout ? member.status : done.status, stalled: false, timeout: Boolean(done.timeout) };
  }

  system(room, body) {
    const msg = { id: id(), ts: now(), room, kind: 'system', from: { name: 'hub', role: 'system', kind: 'system' }, text: body };
    this.store.appendRoom(room, msg);
    this.broadcast('room/message', msg, room);
  }

  async dispatch(conn, body, room, media = null) {
    this.owner(conn);
    const files = this.media.attachments(media);
    body = text(body, 'text', Boolean(files));
    const members = this.list(conn, room);
    const pick = await route(body || (files ? files.map((f) => f.name).join(' ') : ''), members, { ...this.router, console: this.console });
    if (!pick) throw fail(404, 'No agent is connected');
    const result = await this.send(conn, pick.agent, body, 'command', null, media);
    this.console.log(`hub: dispatch -> ${pick.agent} (${pick.reason})`);
    return { ...result, agent: pick.agent, reason: pick.reason, candidates: pick.candidates || [] };
  }

  pushInbox(name, msg) {
    const list = this.inbox.get(name) || [];
    list.push(msg);
    this.inbox.set(name, list.slice(-500));
    this.saveInbox();
  }

  inboxFor(conn, since) {
    if (!conn.name) throw fail(400, 'Register first');
    const list = this.inbox.get(conn.name) || [];
    return since ? list.filter((m) => m.ts > since) : list;
  }

  ack(conn, ids) {
    if (!conn.name) throw fail(400, 'Register first');
    const drop = new Set(Array.isArray(ids) ? ids : [ids]);
    const list = (this.inbox.get(conn.name) || []).filter((m) => !drop.has(m.id));
    this.inbox.set(conn.name, list);
    this.saveInbox();
    return { pending: list.length };
  }

  saveInbox() {
    this.store.saveJson('inbox.json', Object.fromEntries(this.inbox));
  }

  history(conn, room, limit = 50, since = null) {
    const target = room || (conn.room !== '*' ? conn.room : null);
    if (!target) throw fail(400, 'room is required');
    if (conn.record.role !== 'owner' && conn.room !== target) throw fail(403, 'Not your room');
    return this.store.tailRoom(target, Math.min(Number(limit) || 50, 500), since);
  }

  /// Rooms with herdr-style rollups: how many agents are working, blocked, or done unseen.
  rooms() {
    const empty = (room) => ({ room, agents: 0, online: 0, working: 0, blocked: 0, attention: 0 });
    // every room with a log or a member, so one a human just opened is listed before anyone speaks
    const summary = new Map(['default', ...this.store.rooms()].map((room) => [room, empty(room)]));
    for (const m of this.members.values()) {
      if (!m.room || !ROOM.test(m.room)) continue; // "*" and names from before they were checked
      const s = summary.get(m.room) || empty(m.room);
      summary.set(m.room, s);
      if (m.kind !== 'agent') continue;
      s.agents++;
      if (m.connected) s.online++;
      if (m.connected && m.status === 'working') s.working++;
      if (m.connected && m.status === 'blocked') s.blocked++;
      if (m.attention) s.attention++;
      summary.set(m.room, s);
    }
    return [...summary.values()].sort((a, b) => a.room.localeCompare(b.room));
  }

  // MARK: fan-out

  emit(client, event, data) {
    try {
      client.emit(event, data);
    } catch (error) {
      this.console.warn(`hub: event ${event} failed: ${error.message}`);
    }
  }

  broadcast(event, data, room = null) {
    this.events.emit(event, data);
    for (const conn of this.conns.values()) {
      if (!conn.name && conn.room !== '*') continue;
      if (room && conn.room !== '*' && conn.room !== room) continue;
      this.emit(conn.client, event, data);
    }
  }

  changed() {
    this.broadcast('agents/changed', { members: [...this.members.values()].map((m) => this.publicMember(m)) });
  }
}

module.exports = { Hub, MAX_TEXT, NAME };
