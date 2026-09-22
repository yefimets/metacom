'use strict';

const path = require('node:path');
const fs = require('node:fs');

/// A Telegram group as a window on a room. The bot (TELEGRAM_BOT_TOKEN) long-polls Telegram;
/// in a group the owner types `/join <room>` once and from then on the group sees the room
/// stream (says, commands, agents that need a look) and the owner's messages go in like from
/// the phone: `@Name text` is a command to that agent, anything else is posted to the room. Only the owner's messages are relayed inwards;
/// everyone else in the group only reads. The owner is TELEGRAM_OWNER (username or numeric
/// id) or, when unset, whoever sends the first /join (kept in telegram.json).
const API = 'https://api.telegram.org';
const POLL_SECONDS = 30;
const MAX_MESSAGE = 4000;
const MENTION = /^@(\S+)\s*/;

/// What to do with a line typed in the group; pure so it is testable.
const parse = (text) => {
  const t = String(text || '').trim();
  const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(t);
  if (cmd) return { kind: 'slash', name: cmd[1].toLowerCase(), arg: cmd[2].trim() };
  const m = MENTION.exec(t);
  if (!m) return { kind: 'say', text: t };
  const target = m[1];
  const rest = t.replace(MENTION, '').trim();
  if (target.toLowerCase() === 'room') return { kind: 'say', text: rest };
  return { kind: 'command', to: target, text: rest };
};

/// A room message as one Telegram line. Null for what the group should not see. `text` is
/// the message text in the clear (the caller opened it), or null when it could not be.
const format = (m, text = m.text) => {
  if (m.kind === 'system') return null;
  if (m.from.name.startsWith('tg:')) return null; // came from the group itself
  const head = m.to ? `${m.from.name} > ${m.to}` : m.from.name;
  const files = Array.isArray(m.media) && m.media.length ? ' ' + m.media.map((f) => `[${f.name}]`).join(' ') : '';
  const body = `${text === null ? '[encrypted]' : text || ''}${files}`.trim();
  const line = `${head}: ${body}`;
  return line.length > MAX_MESSAGE ? line.slice(0, MAX_MESSAGE - 1) + '…' : line;
};

const attention = (member) => {
  if (member.status === 'blocked') return `${member.name} needs you${member.reason ? ': ' + member.reason.replace(/^screen: /, '') : ''}`;
  return `${member.name} is done`;
};

class Telegram {
  constructor({ org, console, botToken, owner = '', dataDir, fetchImpl = fetch, api = API }) {
    this.org = org;
    this.console = console;
    this.token = botToken;
    this.base = api;
    this.owner = String(owner || '').replace(/^@/, '');
    this.fetch = fetchImpl;
    this.file = dataDir ? path.join(dataDir, 'telegram.json') : null;
    this.state = this.load();
    this.offset = 0;
    this.stopped = false;
    this.queue = Promise.resolve();
  }

  get enabled() {
    return Boolean(this.token);
  }

  load() {
    try {
      return this.file ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { chats: {} };
    } catch {
      return { chats: {} };
    }
  }

  save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
  }

  isOwner(user) {
    if (!user) return false;
    const owner = this.owner || this.state.owner;
    if (!owner) return false;
    return String(user.id) === String(owner) || (user.username && user.username.toLowerCase() === String(owner).toLowerCase());
  }

  start() {
    if (!this.enabled) return;
    this.org.events.on('room/message', (m) => this.onRoomMessage(m));
    this.org.events.on('agents/attention', (member) => this.onAttention(member));
    this.poll().catch((error) => this.console.error(`telegram: poll stopped: ${error.message}`));
    const chats = Object.keys(this.state.chats).length;
    this.console.log(`telegram: on, ${chats} group${chats === 1 ? '' : 's'} joined, owner ${this.owner || this.state.owner || '(first /join claims it)'}`);
  }

  stop() {
    this.stopped = true;
  }

  async api(method, body) {
    const res = await this.fetch(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((POLL_SECONDS + 10) * 1000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(`telegram ${method}: ${json.description || res.status}`);
    return json.result;
  }

  async poll() {
    while (!this.stopped) {
      let updates = [];
      try {
        updates = await this.api('getUpdates', { offset: this.offset, timeout: POLL_SECONDS, allowed_updates: ['message'] });
      } catch (error) {
        this.console.warn(`telegram: ${error.message}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        if (u.message) await this.onUpdate(u.message).catch((error) => this.console.warn(`telegram: ${error.message}`));
      }
    }
  }

  // MARK: inbound

  async onUpdate(msg) {
    const chat = msg.chat || {};
    const chatId = String(chat.id);
    const text = msg.text || msg.caption || '';
    if (!text) return;
    const action = parse(text);
    if (action.kind === 'slash') return this.slash(chatId, chat, msg.from, action);
    const bound = this.state.chats[chatId];
    if (!bound) return;
    if (!this.isOwner(msg.from)) return; // others in the group only read
    const conn = this.org.local(`tg:${msg.from.username || msg.from.first_name || msg.from.id}`);
    const { keys } = this.org;
    try {
      if (action.kind === 'say') {
        this.org.say(conn, bound.room, keys.close(bound.room, action.text));
      } else {
        const room = this.org.members.get(action.to)?.room || bound.room;
        const r = await this.org.send(conn, action.to, keys.close(room, action.text), 'command');
        if (!r.delivered) await this.reply(chatId, `${r.to} is offline, queued`);
      }
    } catch (error) {
      await this.reply(chatId, error.message);
    }
  }

  async slash(chatId, chat, from, { name, arg }) {
    const bound = this.state.chats[chatId];
    if (name === 'start' || name === 'help') {
      return this.reply(chatId, 'metacom. /join <room> binds this group to a room, /leave unbinds, /agents lists them, /read <agent> shows its screen. Then: "@Name text" commands an agent, anything else goes to the room.');
    }
    if (name === 'join') {
      if (!this.owner && !this.state.owner && from) {
        this.state.owner = from.username || String(from.id);
        this.console.log(`telegram: owner is now ${this.state.owner} (first /join)`);
      }
      if (!this.isOwner(from)) return this.reply(chatId, 'only the owner can bind this group');
      const room = String(arg || 'default').split(/\s+/)[0].slice(0, 64);
      this.state.chats[chatId] = { room, title: chat.title || chat.username || chatId, since: new Date().toISOString() };
      this.save();
      this.console.log(`telegram: group "${this.state.chats[chatId].title}" joined room ${room}`);
      return this.reply(chatId, `joined room ${room}`);
    }
    if (!bound) return this.reply(chatId, 'not joined to a room yet: /join <room>');
    if (!this.isOwner(from)) return;
    const conn = this.org.local('tg:' + (from.username || from.id));
    if (name === 'leave') {
      delete this.state.chats[chatId];
      this.save();
      return this.reply(chatId, `left room ${bound.room}`);
    }
    if (name === 'agents') {
      const list = this.org.list(conn, bound.room).filter((m) => m.kind === 'agent');
      if (list.length === 0) return this.reply(chatId, `no agents in ${bound.room}`);
      return this.reply(chatId, list.map((m) => `${m.connected ? m.status : 'stopped'}  ${m.name}${m.host ? ' @ ' + m.host : ''}${m.attention ? '  !' : ''}`).join('\n'));
    }
    if (name === 'read') {
      const agent = arg.split(/\s+/)[0];
      if (!agent) return this.reply(chatId, 'usage: /read <agent>');
      const r = await this.org.read(conn, agent, 40);
      const text = this.org.keys.open(this.org.members.get(r.name)?.room, r.text);
      if (text === null) return this.reply(chatId, 'the screen is encrypted for a room this server was not granted');
      return this.reply(chatId, '```\n' + (text || '(empty)').slice(-MAX_MESSAGE + 10) + '\n```', 'Markdown');
    }
    return undefined;
  }

  // MARK: outbound

  chatsFor(room) {
    return Object.entries(this.state.chats).filter(([, c]) => c.room === room).map(([id]) => id);
  }

  onRoomMessage(m) {
    const line = format(m, this.org.keys.open(m.room, m.text));
    if (!line) return;
    for (const chatId of this.chatsFor(m.room)) this.reply(chatId, line).catch(() => {});
  }

  onAttention(member) {
    for (const chatId of this.chatsFor(member.room)) this.reply(chatId, attention(member)).catch(() => {});
  }

  /// Sends run one after another; Telegram throttles a group at about 20 messages a minute.
  reply(chatId, text, parseMode = undefined) {
    const send = () =>
      this.api('sendMessage', { chat_id: chatId, text: text.slice(0, MAX_MESSAGE + 90), parse_mode: parseMode, disable_web_page_preview: true }).catch((error) => {
        this.console.warn(`telegram: send to ${chatId} failed: ${error.message}`);
      });
    this.queue = this.queue.then(send);
    return this.queue;
  }
}

module.exports = { Telegram, parse, format, attention };
