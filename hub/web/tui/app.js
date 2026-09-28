'use strict';

// The terminal chat (cli/src/chat) for a browser, line for line: what is drawn, in what colour,
// and what the keys do. Where the terminal needs a key, a tap does the same here: names, ↩ and ↪
// under a message, a room in the list, and on a phone the rooms button under the input.

// MARK: hub. A metacom client small enough to live here: calls get callbacks by id, events go
// to listeners by "unit/name". Reconnects and signs in again when the socket drops.

class Hub {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.calls = new Map();
    this.listeners = new Map();
    this.ws = null;
    this.onOpen = async () => {};
    this.onState = () => {};
  }

  on(event, fn) {
    this.listeners.set(event, [...(this.listeners.get(event) || []), fn]);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = async () => {
        try {
          const me = await this.call('auth/signin', { token: this.token });
          await this.onOpen(me);
          this.onState(true);
          resolve(me);
        } catch (error) {
          reject(error);
        }
      };
      ws.onmessage = ({ data }) => {
        let packet = null;
        try {
          packet = JSON.parse(data);
        } catch {
          return;
        }
        if (packet.type === 'callback') {
          const pending = this.calls.get(packet.id);
          if (!pending) return;
          this.calls.delete(packet.id);
          if (packet.error) pending.reject(new Error(packet.error.message));
          else pending.resolve(packet.result);
        } else if (packet.type === 'event') {
          for (const fn of this.listeners.get(packet.name) || []) fn(packet.data);
        }
      };
      ws.onclose = () => {
        this.onState(false);
        for (const p of this.calls.values()) p.reject(new Error('disconnected'));
        this.calls.clear();
        if (this.token) setTimeout(() => this.connect().catch(() => {}), 2000);
      };
      ws.onerror = () => {};
    });
  }

  call(method, args = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('not connected'));
      const id = crypto.randomUUID();
      this.calls.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'call', id, method, args }));
      setTimeout(() => {
        if (!this.calls.has(id)) return;
        this.calls.delete(id);
        reject(new Error('timeout'));
      }, 20000);
    });
  }
}

// MARK: bits

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const span = (text, cls, color) => {
  const s = el('span', cls, text);
  if (color) s.style.color = color;
  return s;
};
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode
    }
  },
};
const time = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Name colours: the hub's index into this palette (hub/lib/colors.js), the chat's order; a name
// the hub has not coloured falls back to its hash over the first ten, as the chat does.
const PALETTE = ['#61AFEF', '#E88F4C', '#98C379', '#C678DD', '#56B6C2', '#E5C07B', '#E06C75', '#7DC8A0', '#BEA0E6', '#DCA08C', '#FF79C6', '#8BE9FD', '#F1FA8C', '#4EC9B0', '#FFB86C', '#A6ACEC', '#D7875F', '#B5CEA8', '#FF6E6E', '#87AFFF'];
const hash = (s) => {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};
const nameColor = (name) => {
  const m = state.all.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  return PALETTE[m && typeof m.color === 'number' ? m.color % PALETTE.length : hash(String(name).toLowerCase()) % 10];
};

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// MARK: state

const state = {
  hub: null,
  me: { name: '', role: '?' },
  room: store.get('tui.room') || 'dev',
  all: [], // every member, every room
  members: new Map(), // this room's
  rooms: [],
  lastMessage: null,
  picker: null, // { index }
  popup: { kind: null, items: [], index: 0 },
  forward: null, // a message held to forward
  files: [], // { token, file }
  history: [],
  historyAt: -1,
  status: null,
  statusTimer: null,
  busy: null,
  frame: 0,
};

const stateOf = (m) => (!m.connected ? 'offline' : m.status === 'working' ? 'working' : 'online');

// MARK: markdown, as the chat reads it (cli/src/chat/markdown.ts)

const CODE = /`([^`\n]+)`/;
const BOLD = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/;
const ITALIC = /(?:^|(?<=[^\w*]))\*([^*\n]+)\*(?![\w*])|(?:^|(?<=[^\w_]))_([^_\n]+)_(?![\w_])/;
const LINKS = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]|\[[^[\]\n]{1,120}\.[a-z0-9]{1,6}\]|@[a-z0-9][a-z0-9._-]*[a-z0-9]|@[a-z0-9]/gi;

const inline = (text, msg, style = {}) => {
  const frag = document.createDocumentFragment();
  const wrap = (node) => {
    if (style.bold) node.classList?.add('b');
    if (style.italic && node.style) node.style.fontStyle = 'italic';
    if (style.muted) node.classList?.add('muted');
    return node;
  };
  const code = CODE.exec(text);
  if (code) {
    frag.append(inline(text.slice(0, code.index), msg, style), wrap(span(code[1], 'code')), inline(text.slice(code.index + code[0].length), msg, style));
    return frag;
  }
  const bold = BOLD.exec(text);
  if (bold) {
    frag.append(inline(text.slice(0, bold.index), msg, style), inline(bold[1] ?? bold[2], msg, { ...style, bold: true }), inline(text.slice(bold.index + bold[0].length), msg, style));
    return frag;
  }
  const italic = ITALIC.exec(text);
  if (italic) {
    const body = italic[1] ?? italic[2];
    const at = text.indexOf(body, italic.index) - 1;
    frag.append(inline(text.slice(0, at), msg, style), inline(body, msg, { ...style, italic: true }), inline(text.slice(at + body.length + 2), msg, style));
    return frag;
  }
  // links, files and names: a tap opens them or addresses them, as a click does in the chat
  const files = new Map((msg.media || []).map((f) => [f.name, f]));
  let last = 0;
  for (const m of text.matchAll(LINKS)) {
    const word = m[0];
    let node = null;
    if (/^https?:/i.test(word)) {
      node = el('a', 'link', word);
      node.href = word;
      node.target = '_blank';
      node.rel = 'noopener';
    } else if (word.startsWith('[')) {
      const f = files.get(word.slice(1, -1));
      if (f) {
        node = el('a', 'link', word);
        node.href = f.url;
        node.target = '_blank';
        node.rel = 'noopener';
      }
    } else {
      const name = word.slice(1);
      if (state.members.has(name) || state.all.some((x) => x.name === name)) {
        node = el('button', 'mention', word);
        node.type = 'button';
        node.style.color = nameColor(name);
        if (name !== state.me.name) node.onclick = () => address(name);
      }
    }
    if (!node) continue;
    frag.append(wrap(span(text.slice(last, m.index))), wrap(node));
    last = m.index + word.length;
  }
  frag.append(wrap(span(text.slice(last))));
  return frag;
};

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^(\s*)>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

const renderBody = (body, msg) => {
  const box = el('div', 'body');
  let fenced = false;
  for (const raw of body.split('\n')) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    const line = el('div', 'line');
    if (fenced) {
      line.append(span('  ' + raw.replace(/\t/g, '  '), 'code'));
      line.style.whiteSpace = 'pre';
      line.style.overflowX = 'auto';
    } else if (raw.trim() === '') {
      line.textContent = '';
    } else if (RULE.test(raw)) {
      line.append(span('─'.repeat(40), 'rule'));
    } else if (HEADING.exec(raw)) {
      line.append(inline(HEADING.exec(raw)[2], msg, { bold: true }));
    } else if (QUOTE.exec(raw)) {
      const q = QUOTE.exec(raw);
      const lead = `${q[1]}│ `;
      line.classList.add('hang');
      line.style.setProperty('--hang', `${lead.length}ch`);
      line.append(span(lead, 'quote'), inline(q[2], msg, { muted: true }));
    } else if (ORDERED.exec(raw) || BULLET.exec(raw)) {
      const [, pad, mark, rest] = ORDERED.exec(raw) || BULLET.exec(raw);
      const ordered = /^\d/.test(mark);
      const lead = `${pad}${ordered ? mark : '·'} `;
      line.classList.add('hang');
      line.style.setProperty('--hang', `${lead.length}ch`);
      line.append(span(lead, ordered ? '' : 'bullet'), inline(rest, msg));
    } else {
      const pad = /^\s*/.exec(raw)[0];
      if (pad) {
        line.classList.add('hang');
        line.style.setProperty('--hang', `${pad.length}ch`);
      }
      line.append(span(pad), inline(raw.slice(pad.length), msg));
    }
    box.append(line);
  }
  return box;
};

// MARK: the conversation

const feed = $('feed');
const pinned = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
const toBottom = () => {
  feed.scrollTop = feed.scrollHeight;
};
const push = (node) => {
  const stick = pinned();
  feed.append(node);
  const kids = feed.querySelectorAll('.entry');
  if (kids.length > 500) for (const k of [...kids].slice(0, kids.length - 400)) k.remove();
  if (stick) toBottom();
};

const nameNode = (name, kind) => {
  const b = el('button', 'name', name);
  b.type = 'button';
  b.style.color = nameColor(name);
  if (name !== state.me.name) b.onclick = () => address(name);
  return b;
};

const FORWARDED = /^\[forwarded from ([^\]]+)\]\s*/;

// Consecutive messages from one sender within two minutes drop the repeated time and name.
const grouped = (m) => {
  if (m.kind === 'system') {
    state.lastMessage = null;
    return false;
  }
  const from = m.from?.name ?? '?';
  const ts = Date.parse(m.ts);
  const g = Boolean(state.lastMessage && state.lastMessage.name === from && !m.to && !state.lastMessage.to && ts - state.lastMessage.ts < 120000);
  state.lastMessage = { name: from, ts, to: m.to };
  return g;
};

const renderMessage = (m) => {
  if (m.kind === 'system') {
    const row = el('div', 'entry system muted');
    row.textContent = `· ${m.text}  ${time(m.ts)}`;
    return row;
  }
  const isGrouped = grouped(m);
  const node = el('div', 'entry message');
  if (isGrouped && node.previousSibling) node.style.marginTop = '0';
  const from = m.from?.name ?? '?';
  const control = m.kind === 'control';
  const forwarded = FORWARDED.exec(m.text);
  if (!isGrouped) {
    const head = el('div', 'head');
    head.append(nameNode(from, m.from?.kind));
    if (m.to) {
      head.append(span(control ? '⌘' : '→', 'arrow', control ? 'var(--accent)' : m.kind === 'info' ? 'var(--muted)' : 'var(--fg)'), nameNode(m.to));
    }
    head.append(span(`  ${time(m.ts)}${forwarded ? `  [forwarded from ${forwarded[1]}]` : ''}`, 'muted'));
    node.append(head);
  } else {
    // a burst from one sender reads as one block
    const prev = feed.lastElementChild;
    if (prev && prev.classList.contains('message')) prev.style.marginBottom = '0';
  }
  const body = renderBody(m.text.replace(FORWARDED, ''), m);
  if (control) body.classList.add('accent');
  node.append(body);
  const actions = el('div', 'actions');
  const reply = el('button', '', '↩ reply');
  reply.type = 'button';
  reply.onclick = () => {
    const who = from !== state.me.name ? from : m.to && m.to !== state.me.name ? m.to : null;
    if (who) address(who);
  };
  const fwd = el('button', '', '↪ forward');
  fwd.type = 'button';
  fwd.onclick = () => startForward(m);
  actions.append(reply, fwd);
  for (const f of m.media || []) {
    const a = el('a', '', `↗ ${f.name.length > 32 ? f.name.slice(0, 31) + '…' : f.name}`);
    a.href = f.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.color = 'var(--muted)';
    a.style.marginRight = '2ch';
    a.style.textDecoration = 'none';
    actions.append(a);
  }
  node.append(actions);
  return node;
};

const note = (text, tone = 'warn') => {
  // warnings and errors stay in the conversation, drawn like "misha joined"; the rest is said
  // under the input for a moment
  if (tone !== 'warn' && tone !== 'error') return setStatus(text, tone === 'dim' ? 'plain' : tone, 4000);
  state.lastMessage = null;
  const row = el('div', 'entry system muted');
  row.append(span('·', '', tone === 'warn' ? 'var(--warning)' : 'var(--error)'), document.createTextNode(` ${text}  ${time(new Date().toISOString())}`));
  push(row);
};

const block = (node) => {
  const b = el('div', 'entry block');
  b.append(node);
  push(b);
};

const banner = () => {
  const b = el('div', 'entry banner');
  const line = el('div');
  line.append(span('metacom', 'b primary'), span(' · ', 'muted'), span(state.room, 'b'), span(` at ${location.host} as `, 'muted'), nameNode(state.me.name), span(` (${state.me.role})`, 'muted'), span(' · web', 'muted'));
  b.append(line, span('@Name to address an agent · / for commands · /help for keys', 'muted'));
  return b;
};

// A night of dropped connections: "X left" then "X joined" within ten minutes is not a
// departure; what is left of a run keeps each person's last line (as the chat does).
const JOIN_LEFT = /^(\S+) (left|joined)(?: from .*)?$/;
const foldReconnects = (list) => {
  const drop = new Set();
  const open = new Map();
  for (const m of list) {
    const hit = m.kind === 'system' && JOIN_LEFT.exec(m.text);
    if (!hit) continue;
    const left = open.get(hit[1]);
    if (hit[2] === 'left') open.set(hit[1], m);
    else if (left && Date.parse(m.ts) - Date.parse(left.ts) < 600000) {
      drop.add(left.id);
      drop.add(m.id);
      open.delete(hit[1]);
    }
  }
  const out = [];
  let run = [];
  const flush = () => {
    const lastOf = new Map(run.map((m) => [JOIN_LEFT.exec(m.text)[1], m]));
    out.push(...run.filter((m) => lastOf.get(JOIN_LEFT.exec(m.text)[1]) === m));
    run = [];
  };
  for (const m of list) {
    if (drop.has(m.id)) continue;
    if (m.kind === 'system' && JOIN_LEFT.test(m.text)) run.push(m);
    else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
};

const load = async () => {
  feed.replaceChildren(el('div', 'spacer'));
  state.lastMessage = null;
  push(banner());
  const history = foldReconnects(await state.hub.call('room/history', { room: state.room, limit: 300 })).slice(-30);
  for (const m of history) push(renderMessage(m));
  if (history.length) push(Object.assign(el('div', 'entry rule-now'), { textContent: `${'─'.repeat(24)} now` }));
  toBottom();
  markRead();
};

let readTimer = null;
const markRead = () => {
  if (readTimer) return;
  readTimer = setTimeout(() => {
    readTimer = null;
    state.hub.call('room/read', { room: state.room }).catch(() => {});
  }, 1000);
};

// MARK: the line above the input

const renderStatus = () => {
  const who = $('status').querySelector('.who');
  const me = $('status').querySelector('.me');
  const list = [...state.members.values()]
    .filter((m) => m.name !== state.me.name && m.connected)
    .sort((a, b) => (stateOf(a) === 'working' ? 0 : 1) - (stateOf(b) === 'working' ? 0 : 1) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || a.name.localeCompare(b.name));
  who.replaceChildren();
  if (!list.length) who.append(span('nobody else here', 'muted'));
  for (const m of list) {
    const b = el('button');
    b.type = 'button';
    const s = stateOf(m);
    const glyph = m.kind === 'human' ? '◆' : s === 'working' ? SPIN[state.frame % SPIN.length] : '●';
    b.append(span(glyph, '', 'var(--success)'), document.createTextNode(' '), span(m.name, '', nameColor(m.name)));
    if (s === 'working') b.append(span(' working', 'muted'));
    b.onclick = () => address(m.name);
    who.append(b);
  }
  me.replaceChildren(document.createTextNode(`${state.me.name} · `), span(state.room, 'room'));
};
setInterval(() => {
  if (![...state.members.values()].some((m) => m.connected && m.status === 'working') && !state.busy) return;
  state.frame++;
  renderStatus();
  if (state.busy) renderHint();
}, 80);

// MARK: the hint under the input

const setStatus = (text, tone = 'ok', ms = 0) => {
  clearTimeout(state.statusTimer);
  state.status = text ? { text, tone } : null;
  renderHint();
  if (text && ms) state.statusTimer = setTimeout(() => {
    state.status = null;
    renderHint();
  }, ms);
};

const CONTROL = /^!(?:(?:cancel|esc|stop|keys|type)\b|\/)/;
const renderHint = () => {
  const hint = $('hint');
  hint.replaceChildren();
  hint.className = 'muted';
  if (state.status) {
    const t = state.status.tone;
    hint.className = t === 'warn' ? 'warning' : t === 'error' ? 'error' : t === 'plain' ? 'muted' : 'success';
    hint.textContent = state.status.text;
    return;
  }
  if (state.busy) {
    hint.append(span(SPIN[state.frame % SPIN.length], 'primary'), document.createTextNode(` ${state.busy}`));
    return;
  }
  const text = $('text').value;
  const pending = state.files.filter((f) => text.includes(f.token)).length;
  const files = pending ? ` with ${pending} file${pending > 1 ? 's' : ''}` : '';
  if (state.picker) return void (hint.textContent = 'filter or new room · ↑↓ enter · esc back');
  if (!text) return void (hint.textContent = '@ to address an agent · / for commands · shift+enter new line · /help');
  const mentions = [...text.matchAll(/(^|\s)@([^\s]+)/g)].map((m) => m[2].replace(/[.,:;!?]+$/, ''));
  const head = mentions.find((n) => state.members.has(n)) ?? (text.startsWith('@') ? mentions[0] : undefined);
  if (head) {
    const m = state.members.get(head);
    if (!m) {
      hint.append(span(`nobody called ${head} is in this room`, 'warning'), span(' · /say to post it anyway', 'muted'));
      return;
    }
    hint.textContent = m.kind === 'agent' ? `enter types this${files} into ${m.name}${m.connected ? '' : ' when it comes back'}` : `enter sends this${files} to ${m.name} directly`;
    return;
  }
  if (text.startsWith('/')) return void (hint.textContent = 'enter runs the command');
  if (CONTROL.test(text)) {
    hint.className = 'warning';
    hint.textContent = 'control commands go to an agent: @Alex !cancel';
    return;
  }
  hint.textContent = `enter posts to ${state.room}${files}`;
};

// MARK: the input

const input = $('text');
const autosize = () => {
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
};
const placeholder = () => {
  input.placeholder = state.picker ? 'filter or new room · ↑↓ enter · esc back' : `message ${state.room} · @ for agents · / for commands · ← rooms`;
};

const address = (name) => {
  input.value = `@${name} ` + input.value.replace(/^@\S*\s*/, '');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  onInput();
};

const COMMANDS = [
  { name: 'agents', args: '', help: 'who is in the room and what they are doing' },
  { name: 'read', args: '<name> [lines]', help: "an agent's screen (owner)" },
  { name: 'wait', args: '<name>', help: 'block until the agent is idle or needs you' },
  { name: 'seen', args: '<name>', help: 'clear the done badge' },
  { name: 'cancel', args: '<name>', help: 'send Esc to the agent' },
  { name: 'keys', args: '<name> enter|esc|up|down|y', help: 'press keys in the agent' },
  { name: 'say', args: '<text>', help: 'post to the room even if it starts with @ or /' },
  { name: 'attach', args: '', help: 'put a file into the message (or paste, or drop one)' },
  { name: 'rooms', args: '', help: 'all rooms with counts (or ← on an empty line)' },
  { name: 'room', args: '<name>', help: 'open another room, creating it if it is new' },
  { name: 'clear', args: '', help: 'clear the screen' },
  { name: 'help', args: '', help: 'keys and commands' },
];

// The list over the input: members after "@", commands after a leading "/".
const computePopup = () => {
  const text = input.value;
  const upto = text.slice(0, input.selectionStart);
  const at = /(^|\s)@([^\s]*)$/.exec(upto);
  if (at && !state.forward) {
    const q = at[2].toLowerCase();
    const items = [...state.members.values(), { name: 'auto', kind: 'route' }]
      .filter((m) => m.name !== state.me.name && m.name.toLowerCase().includes(q))
      .sort((a, b) => (a.connected === b.connected ? 0 : a.connected ? -1 : 1) || a.name.localeCompare(b.name))
      .map((m) => ({ label: m.name, member: m }));
    return { kind: 'mention', items, query: at[2] };
  }
  if (state.forward) {
    const q = text.replace(/^@/, '').toLowerCase();
    return { kind: 'mention', items: [...state.members.values()].filter((m) => m.name !== state.me.name && m.name.toLowerCase().includes(q)).map((m) => ({ label: m.name, member: m })), query: q };
  }
  const cmd = /^\/(\S*)$/.exec(upto);
  if (cmd) {
    const q = cmd[1].toLowerCase();
    return { kind: 'command', items: COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ label: c.name, command: c })), query: cmd[1] };
  }
  return { kind: null, items: [] };
};

const renderPopup = () => {
  const box = $('popup');
  const p = state.popup;
  box.classList.toggle('open', Boolean(p.kind && p.items.length));
  box.replaceChildren();
  if (!p.kind || !p.items.length) return;
  const rows = 6;
  const top = Math.max(0, Math.min(p.index - rows + 1, p.items.length - rows));
  const nameW = Math.max(6, ...p.items.map((i) => i.label.length)) + 1;
  p.items.slice(top, top + rows).forEach((item, i) => {
    const active = top + i === p.index;
    const row = el('button', `item${active ? ' active' : ''}`);
    row.type = 'button';
    row.append(span(active ? '›' : ' ', 'mark'));
    if (p.kind === 'mention') {
      const m = item.member;
      const s = m.kind === 'route' ? 'the hub picks an agent' : stateOf(m);
      const glyph = m.kind === 'route' ? '◎' : m.kind === 'human' ? (m.connected ? '◆' : '◇') : s === 'offline' ? '○' : '●';
      row.append(span(glyph, '', m.kind === 'route' ? 'var(--accent)' : s === 'offline' ? 'var(--muted)' : 'var(--success)'), document.createTextNode(' '));
      row.append(span(('@' + item.label).padEnd(nameW), 'label', nameColor(m.name)), document.createTextNode(' '), span(s.padEnd(9), 'muted'), document.createTextNode(' '));
      row.append(span([m.host ? '@' + m.host : '', m.repo || ''].filter(Boolean).join('  '), 'muted'));
    } else {
      const c = item.command;
      row.append(span(('/' + c.name).padEnd(nameW), 'label', active ? 'var(--primary)' : 'var(--fg)'), document.createTextNode(' '), span(c.args.padEnd(28), 'muted'), document.createTextNode(' '), span(c.help, 'muted'));
    }
    row.onmousedown = (e) => e.preventDefault(); // keep the keyboard up on a phone
    row.onclick = () => {
      state.popup.index = top + i;
      choose();
    };
    box.append(row);
  });
  box.append(span(`  ↑↓ choose · tab inserts · esc closes${p.items.length > rows ? ` · ${p.items.length} matches` : ''}`, 'hint'));
};

const choose = () => {
  const p = state.popup;
  const item = p.items[p.index];
  if (!item) return;
  if (state.forward && p.kind === 'mention') {
    const held = state.forward;
    state.forward = null;
    input.value = '';
    forward(held, item.member);
    return onInput();
  }
  const text = input.value;
  const upto = text.slice(0, input.selectionStart);
  const rest = text.slice(input.selectionStart);
  const insert = p.kind === 'mention' ? `@${item.label} ` : `/${item.label} `;
  const start = p.kind === 'mention' ? upto.replace(/@[^\s]*$/, '') : '';
  input.value = start + insert + rest.replace(/^\S*/, '');
  const at = (start + insert).length;
  input.setSelectionRange(at, at);
  onInput();
};

const onInput = () => {
  autosize();
  if (state.picker) return renderPicker();
  const next = computePopup();
  const same = next.kind === state.popup.kind && next.items.length === state.popup.items.length;
  state.popup = { ...next, index: same ? Math.min(state.popup.index, Math.max(0, next.items.length - 1)) : 0 };
  renderPopup();
  renderHint();
};

input.addEventListener('input', onInput);
input.addEventListener('click', onInput);
input.addEventListener('keydown', (e) => {
  const p = state.popup;
  const open = !state.picker && p.kind && p.items.length;
  if (state.picker) return pickerKey(e);
  if (open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    p.index = (p.index + (e.key === 'ArrowUp' ? -1 : 1) + p.items.length) % p.items.length;
    return renderPopup();
  }
  if (open && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && (p.kind === 'mention' || !input.value.includes(' '))))) {
    e.preventDefault();
    return choose();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (state.forward) {
      state.forward = null;
      input.value = '';
      setStatus('forwarding cancelled', 'warn', 1500);
      return onInput();
    }
    if (open) {
      state.popup = { kind: null, items: [], index: 0 };
      return renderPopup();
    }
    input.value = '';
    return onInput();
  }
  if (e.key === 'ArrowLeft' && !input.value) {
    e.preventDefault();
    return openPicker();
  }
  // ↑ on the first line walks back through what you sent
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !input.value.slice(0, input.selectionStart).includes('\n') && state.history.length) {
    if (e.key === 'ArrowDown' && state.historyAt < 0) return;
    e.preventDefault();
    state.historyAt = e.key === 'ArrowUp' ? Math.min(state.history.length - 1, state.historyAt + 1) : state.historyAt - 1;
    input.value = state.historyAt < 0 ? '' : state.history[state.history.length - 1 - state.historyAt];
    return onInput();
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (input.value.endsWith('\\')) {
      input.value = input.value.slice(0, -1) + '\n';
      return onInput();
    }
    submit();
  }
});

// Files: pasted or dropped ones wait as a token in the text, "[image 1.png]", and go with the
// message if the token is still there when it is sent.
let imageSeq = 0;
const attach = (file) => {
  const name = file.name && file.name !== 'image.png' ? file.name : `image ${++imageSeq}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
  const token = `[${name}]`;
  state.files.push({ token, file, name });
  const at = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, at) + token + ' ' + input.value.slice(at);
  onInput();
};
input.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])].filter((it) => it.kind === 'file');
  if (!items.length) return;
  e.preventDefault();
  for (const it of items) attach(it.getAsFile());
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) attach(f);
});
$('fileInput').addEventListener('change', (e) => {
  for (const f of e.target.files) attach(f);
  e.target.value = '';
});

const upload = async (f) => {
  const res = await fetch('/media', {
    method: 'POST',
    headers: { 'Content-Type': f.file.type || 'application/octet-stream', Authorization: `Bearer ${state.hub.token}`, 'X-Name': encodeURIComponent(f.name) },
    body: f.file,
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || `upload failed (${res.status})`);
  return { ...(await res.json()), name: f.name };
};
const uploadAll = async (text) => {
  const list = state.files.filter((f) => text.includes(f.token)).sort((a, b) => text.indexOf(a.token) - text.indexOf(b.token));
  if (!list.length) return undefined;
  const out = [];
  for (const f of list) {
    setBusy(`uploading ${f.name}…`);
    out.push(await upload(f));
  }
  return out;
};
const setBusy = (text) => {
  state.busy = text;
  renderHint();
};

// MARK: sending, as the chat does it

const mentioned = (t) => {
  for (const m of t.matchAll(/(^|\s)@([^\s]+)/g)) {
    const name = m[2].replace(/[.,:;!?]+$/, '');
    if (state.members.has(name)) return name;
  }
  return t.startsWith('@') ? t.slice(1).split(/\s/)[0] : null;
};

const submit = async () => {
  const t = input.value.trim();
  if (!t) return;
  state.history.push(t);
  state.historyAt = -1;
  const draft = input.value;
  input.value = '';
  onInput();
  setBusy('sending…');
  try {
    if (t.startsWith('/')) await command(t);
    else if (mentioned(t)) await directed(t);
    else if (t.startsWith('>')) await dispatch(t.slice(1).trim());
    else if (CONTROL.test(t)) note('control commands go to an agent, e.g. @Alex !cancel', 'warn');
    else await state.hub.call('room/say', { room: state.room, text: t, media: await uploadAll(t) });
    state.files = state.files.filter((f) => input.value.includes(f.token));
  } catch (error) {
    input.value = draft;
    onInput();
    failure(error);
  } finally {
    setBusy(null);
  }
};

const failure = (error) => {
  let msg = error instanceof Error ? error.message : String(error);
  const blocked = msg.match(/^(\S+) is blocked on a question/);
  if (blocked) msg = `${blocked[1]} is blocked on a question · /read ${blocked[1]} to see it, then @${blocked[1]} !keys y or @${blocked[1]} !cancel`;
  if (/^Owners only/.test(msg)) msg = 'owners only · your token has the agent role';
  note(msg, 'error');
};

const directed = async (t) => {
  const to = mentioned(t);
  const lead = t.match(new RegExp(`^@${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*([\\s\\S]*)$`));
  const body = lead ? lead[1].trim() : t;
  if (to === 'auto') return dispatch(body);
  const member = state.members.get(to);
  if (!member) {
    await state.hub.call('room/say', { room: state.room, text: t });
    return note(`posted to the room as text (nobody called ${to} is here)`, 'dim');
  }
  if (!body) return note(`say something after @${to}`, 'warn');
  const kind = member.kind === 'agent' ? 'command' : 'info';
  const r = await state.hub.call('agents/send', { to, text: body, kind, media: await uploadAll(body) });
  if (!r.delivered) note(`${to} is offline, queued until it is back`, 'dim');
};

const dispatch = async (body) => {
  if (!body) return note('say what to do after @auto', 'warn');
  const r = await state.hub.call('agents/dispatch', { text: body, room: state.room, media: await uploadAll(body) });
  note(`the hub picked ${r.agent} (${r.reason})${r.delivered ? '' : ', queued'}`, 'dim');
};

const startForward = (msg) => {
  state.forward = msg;
  input.value = '@';
  input.focus();
  onInput();
  setStatus(`forwarding ${msg.from?.name ?? '?'}'s message · pick who · esc cancels`, 'ok');
};
const forward = async (msg, member) => {
  const body = `[forwarded from ${msg.from?.name ?? '?'}${msg.to ? ` → ${msg.to}` : ''}] ${msg.text}`;
  try {
    const r = await state.hub.call('agents/send', { to: member.name, text: body, kind: member.kind === 'agent' ? 'command' : 'info', media: msg.media });
    setStatus(r.delivered ? `forwarded to ${member.name}` : `${member.name} is offline, queued`, 'ok', 2500);
  } catch (error) {
    failure(error);
  }
};

// MARK: commands

const row = (k, v) => {
  const r = el('div');
  r.append(span(k.padEnd(34), ''), span(v, 'muted'));
  return r;
};

const command = async (t) => {
  const [cmd, ...rest] = t.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const call = (m, a) => state.hub.call(m, a);
  switch (cmd) {
    case 'help': {
      const box = el('div');
      const H = (s) => span(s, 'b primary');
      box.append(H('messages'), row('text', 'post to the room; @Name inside is a mention'), row('@Alex do the thing', 'typed into that agent when it is idle'), row('@Alex !cancel  !keys y  !/compact', 'control an agent; acts at once'));
      box.append(H('commands'), ...COMMANDS.map((c) => row(`/${c.name} ${c.args}`, c.help)));
      box.append(H('keys'), row('enter', 'send · shift+enter for a new line'), row('@ and /', 'open a list; ↑↓ choose, tab or enter inserts, esc closes'), row('↑ ↓', 'through what you sent'), row('← on an empty line', 'the room list (or the rooms button)'), row('tap', 'a name addresses it · ↩ reply and ↪ forward act on a message'));
      block(box);
      break;
    }
    case 'agents':
    case 'who': {
      const members = [...state.members.values()];
      if (!members.length) return note('nobody here', 'dim');
      const nameW = Math.max(6, ...members.map((m) => m.name.length));
      const box = el('div');
      for (const m of members) {
        const s = stateOf(m);
        const r = el('div');
        const glyph = m.kind === 'human' ? (m.connected ? '◆' : '◇') : s === 'offline' ? '○' : '●';
        r.append(span(glyph, '', s === 'offline' ? 'var(--muted)' : 'var(--success)'), document.createTextNode(' '), span(m.name.padEnd(nameW), 'b', nameColor(m.name)), document.createTextNode(' '), span(s.padEnd(8), 'muted'), document.createTextNode(' '));
        r.append(span([m.host ? '@' + m.host : '', m.repo || '', m.kind === 'agent' && m.accept ? 'accepts ' + (Array.isArray(m.accept) ? m.accept.join(',') : m.accept) : ''].filter(Boolean).join('  '), 'muted'));
        box.append(r);
      }
      block(box);
      break;
    }
    case 'read': {
      const [name, n] = rest;
      if (!name) return note('usage: /read <name> [lines]', 'warn');
      const r = await call('agents/read', { name, lines: Number(n) || 30 });
      const box = el('div');
      box.append(span(`── ${name} screen ──`, 'muted'), Object.assign(el('div', 'screen'), { textContent: r.text.replace(/\s+$/, '') }));
      block(box);
      break;
    }
    case 'wait': {
      const [name] = rest;
      if (!name) return note('usage: /wait <name>', 'warn');
      setBusy(`waiting for ${name}…`);
      const r = await call('agents/wait', { name, timeoutMs: 600000 });
      note(r.timeout ? `still waiting, ${name} is ${r.status}` : `${name} is ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`, r.status === 'blocked' ? 'warn' : 'ok');
      break;
    }
    case 'seen':
      if (!rest[0]) return note('usage: /seen <name>', 'warn');
      await call('agents/seen', { name: rest[0] });
      break;
    case 'cancel':
      if (!rest[0]) return note('usage: /cancel <name>', 'warn');
      await call('agents/send', { to: rest[0], text: '!cancel', kind: 'command' });
      break;
    case 'keys': {
      const [name, ...keys] = rest;
      if (!name || !keys.length) return note('usage: /keys <name> enter|esc|up|down|y', 'warn');
      await call('agents/send', { to: name, text: `!keys ${keys.join(' ')}`, kind: 'command' });
      break;
    }
    case 'say':
      if (!arg) return note('usage: /say <text>', 'warn');
      await call('room/say', { room: state.room, text: arg, media: await uploadAll(arg) });
      break;
    case 'attach':
      $('fileInput').click();
      break;
    case 'rooms':
      openPicker();
      break;
    case 'room':
      if (!arg) return note('usage: /room <name> · or ← on an empty line for the list', 'warn');
      await switchRoom(arg);
      break;
    case 'clear':
      feed.replaceChildren(el('div', 'spacer'));
      state.lastMessage = null;
      break;
    default:
      note(`unknown command /${cmd} · /help lists them`, 'warn');
  }
};

// MARK: rooms

const ROOM = /^[\w][\w.-]{0,63}$/;
const pickerItems = () => {
  const q = input.value.trim();
  const shown = state.rooms.filter((r) => ROOM.test(r.room) && r.room.toLowerCase().includes(q.toLowerCase())).map((r) => ({ room: r.room, summary: r }));
  if (!state.rooms.some((r) => r.room === state.room) && state.room.includes(q)) shown.unshift({ room: state.room });
  if (q && ROOM.test(q) && !shown.some((r) => r.room === q)) shown.push({ room: q, create: true });
  return shown;
};
const counts = (s) => {
  if (!s || s.agents === 0) return 'no agents';
  const parts = [`${s.online}/${s.agents} online`];
  if (s.working) parts.push(`${s.working} working`);
  if (s.blocked) parts.push(`${s.blocked} need you`);
  return parts.join(' · ');
};
const renderPicker = () => {
  const box = $('rooms');
  const items = pickerItems();
  const at = Math.min(state.picker.index, Math.max(0, items.length - 1));
  const nameW = Math.min(28, Math.max(8, ...items.map((i) => i.room.length + 2)));
  box.style.setProperty('--nameW', `${nameW}ch`);
  box.replaceChildren(el('div', 'title', 'rooms'));
  if (!items.length) box.append(span(state.rooms.length ? 'no room matches · type a name to create one' : 'loading…', 'muted'));
  items.forEach((item, i) => {
    const r = el('button', `row${i === at ? ' active' : ''}`);
    r.type = 'button';
    r.append(span(i === at ? '›' : ' ', 'mark'));
    if (item.create) r.append(span(`+ create ${item.room}`, i === at ? 'b primary' : ''));
    else {
      r.append(span(item.room, 'room'), span(counts(item.summary), 'muted'));
      if (item.summary?.unread) r.append(span(` · ${item.summary.unread} unread`, 'b warning'));
      if (item.room === state.room) r.append(span('  · you are here', 'muted'));
    }
    r.onmousedown = (e) => e.preventDefault();
    r.onclick = () => pick(item);
    box.append(r);
  });
  box.scrollTop = box.scrollHeight;
  renderHint();
  placeholder();
};
const openPicker = async () => {
  state.picker = { index: 0 };
  state.popup = { kind: null, items: [], index: 0 };
  renderPopup();
  document.body.classList.add('picking');
  $('roomsBtn').textContent = '× close';
  renderPicker();
  state.rooms = await state.hub.call('room/list', {}).catch(() => state.rooms);
  state.picker.index = Math.max(0, pickerItems().findIndex((i) => i.room === state.room));
  renderPicker();
  input.focus();
};
const closePicker = () => {
  state.picker = null;
  document.body.classList.remove('picking');
  $('roomsBtn').textContent = '← rooms';
  input.value = '';
  placeholder();
  onInput();
  toBottom();
};
const pick = async (item) => {
  closePicker();
  await switchRoom(item.room);
};
const pickerKey = (e) => {
  const items = pickerItems();
  if (e.key === 'Escape') {
    e.preventDefault();
    return closePicker();
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (!items.length) return;
    state.picker.index = (Math.min(state.picker.index, items.length - 1) + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    return renderPicker();
  }
  if (e.key === 'Enter' || (e.key === 'ArrowRight' && input.selectionStart >= input.value.length)) {
    e.preventDefault();
    const item = items[Math.min(state.picker.index, items.length - 1)];
    if (item) pick(item);
    return;
  }
  setTimeout(() => {
    state.picker.index = 0;
    renderPicker();
  });
};
$('roomsBtn').onclick = () => (state.picker ? closePicker() : openPicker());

const switchRoom = async (room) => {
  if (room === state.room) return;
  if (!ROOM.test(room)) return note('a room name is letters, digits, dot, dash or underscore', 'warn');
  state.room = room;
  store.set('tui.room', room);
  await join();
  members(state.all);
  await load();
  placeholder();
};

// MARK: members

const members = (list) => {
  state.all = list;
  state.members = new Map(list.filter((m) => m.room === state.room).map((m) => [m.name, m]));
  renderStatus();
  renderHint();
};

const join = async () => {
  const hub = state.hub;
  await hub.call('agents/register', { name: state.me.name, room: state.room, kind: 'human', host: 'web' });
  await hub.call('room/join', { room: state.room });
  await hub.call('agents/status', { status: 'waiting' }).catch(() => {});
};

// MARK: start

const start = async (token, name) => {
  const hub = new Hub((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/', token);
  state.hub = hub;
  let first = true;
  hub.onOpen = async (me) => {
    state.me = { name, role: me.role };
    if (!first) {
      await join();
      members(await hub.call('agents/list', {}));
    }
  };
  hub.onState = (on) => setBusy(on ? null : 'reconnecting…');
  hub.on('room/message', (m) => {
    if (m.room && m.room !== state.room) return;
    push(renderMessage(m));
    if (m.to === state.me.name) markRead();
  });
  hub.on('agents/changed', ({ members: list }) => members(list));
  await hub.connect();
  first = false;
  await join();
  members(await hub.call('agents/list', {}));
  placeholder();
  await load();
  $('login').classList.add('hidden');
  input.focus();
};

// sign in: the token and the name you go by in the rooms, both remembered on this device
const signIn = async () => {
  const token = $('token').value.trim();
  const name = $('name').value.trim();
  if (!token || !/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name)) {
    $('loginError').textContent = !token ? 'a token, please' : 'a name: letters, digits, dot, dash, underscore';
    return;
  }
  $('loginError').textContent = '';
  try {
    await start(token, name);
    store.set('tui.token', token);
    store.set('tui.name', name);
  } catch (error) {
    $('loginError').textContent = error.message;
    if (state.hub) state.hub.token = null;
  }
};
$('loginBtn').onclick = signIn;
for (const id of ['token', 'name']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && signIn());
$('token').value = store.get('tui.token') || store.get('hub.token') || '';
$('name').value = store.get('tui.name') || '';
if ($('token').value && $('name').value) signIn();

// iOS: the on-screen keyboard shrinks the visual viewport, not the layout one; keep the page
// on the visual viewport so the input stays above the keyboard.
const vv = window.visualViewport;
const fit = () => {
  if (!vv) return;
  const s = document.documentElement.style;
  s.setProperty('--vh', Math.round(vv.height) + 'px');
  s.setProperty('--vv-top', Math.round(vv.offsetTop) + 'px');
  toBottom();
};
if (vv) {
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}
window.addEventListener('scroll', () => {
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
});
placeholder();
renderHint();
