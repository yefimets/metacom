'use strict';

// The terminal chat (cli/src/chat) for a browser, line for line, as Preact components written
// with htm (vendor/htm-preact.umd.js, no build): one component per piece of the terminal —
// Banner, MessageView, StatusBar, Popup, Composer, Footer, RoomPicker — over one small store.
// Where the terminal needs a key, a tap does the same here: names, ↩ and ↪ under a message, a
// room in the list, and on a phone the rooms button under the input.

const { html, render, useEffect, useLayoutEffect, useReducer, useRef } = window.htmPreact;

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

// MARK: store. Everything on screen comes from here; components re-render when it changes.

const saved = {
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

// A room has an address of its own, /opn or /dev: open one by its link, go back and forth
// between rooms with the browser's back and forward.
const ROOM_RE = /^[\w][\w.-]{0,63}$/;
function pathRoom() {
  const p = decodeURIComponent(location.pathname.slice(1));
  return ROOM_RE.test(p) ? p : null;
}
const showRoom = (room, replace = false) => {
  if (pathRoom() === room) return;
  history[replace ? 'replaceState' : 'pushState']({ room }, '', '/' + encodeURIComponent(room));
};

const S = {
  hub: null,
  signedIn: false,
  loginError: '',
  me: { name: '', role: '?' },
  // the room in the address (/opn) wins; else the last one open on this device
  room: pathRoom() || saved.get('tui.room') || 'dev',
  draft: '', // what was being typed before ↑ went into what was sent
  all: [], // every member, every room
  members: new Map(), // this room's
  log: [], // what the conversation shows
  rooms: [],
  picker: null, // { index } while the room list is open
  popup: { kind: null, items: [], index: 0 },
  forward: null, // a message held to forward
  files: [], // { token, file, name }
  text: '',
  caret: null, // where to put the caret after the text was set from code
  history: [],
  historyAt: -1,
  status: null,
  busy: null,
  frame: 0,
};
const listeners = new Set();
const set = (patch = {}) => {
  Object.assign(S, patch);
  for (const fn of listeners) fn();
};
const useStore = () => {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => listeners.delete(force);
  }, []);
  return S;
};

let seq = 0;
const lastMessage = { current: null };
const push = (entry) => {
  const log = [...S.log, { ...entry, id: `e${++seq}` }];
  set({ log: log.length > 500 ? log.slice(-400) : log });
};

// MARK: small things

const time = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const stateOf = (m) => (!m.connected ? 'offline' : m.status === 'working' ? 'working' : 'online');
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
  const key = String(name).toLowerCase();
  const m = S.all.find((x) => x.name.toLowerCase() === key);
  return PALETTE[m && typeof m.color === 'number' ? m.color % PALETTE.length : hash(key) % 10];
};

// MARK: markdown, as the chat reads it (cli/src/chat/markdown.ts)

const CODE = /`([^`\n]+)`/;
const BOLD = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/;
const ITALIC = /(?:^|(?<=[^\w*]))\*([^*\n]+)\*(?![\w*])|(?:^|(?<=[^\w_]))_([^_\n]+)_(?![\w_])/;
const LINKS = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]|\[[^[\]\n]{1,120}\.[a-z0-9]{1,6}\]|@[a-z0-9][a-z0-9._-]*[a-z0-9]|@[a-z0-9]/gi;

const styled = (style) => [style.bold ? 'b' : '', style.muted ? 'muted' : ''].filter(Boolean).join(' ');

/// Inline marks: `code`, **bold**, *italic*, then what a tap acts on — a web address, a
/// "[file]" the message carries, an @name of someone here.
const inline = (text, msg, style = {}) => {
  const code = CODE.exec(text);
  if (code) return [...inline(text.slice(0, code.index), msg, style), html`<span class="code">${code[1]}</span>`, ...inline(text.slice(code.index + code[0].length), msg, style)];
  const bold = BOLD.exec(text);
  if (bold) return [...inline(text.slice(0, bold.index), msg, style), ...inline(bold[1] ?? bold[2], msg, { ...style, bold: true }), ...inline(text.slice(bold.index + bold[0].length), msg, style)];
  const italic = ITALIC.exec(text);
  if (italic) {
    const body = italic[1] ?? italic[2];
    const at = text.indexOf(body, italic.index) - 1;
    return [...inline(text.slice(0, at), msg, style), ...inline(body, msg, { ...style, italic: true }), ...inline(text.slice(at + body.length + 2), msg, style)];
  }
  const cls = styled(style);
  const st = style.italic ? 'font-style: italic' : '';
  const files = new Map((msg.media || []).map((f) => [f.name, f]));
  const out = [];
  let last = 0;
  for (const m of text.matchAll(LINKS)) {
    const word = m[0];
    let node = null;
    if (/^https?:/i.test(word)) node = html`<a class="link" href=${word} target="_blank" rel="noopener">${word}</a>`;
    else if (word.startsWith('[')) {
      const f = files.get(word.slice(1, -1));
      if (f) node = html`<a class="link" href=${f.url} target="_blank" rel="noopener">${word}</a>`;
    } else {
      const name = word.slice(1);
      if (S.all.some((x) => x.name === name)) node = html`<button type="button" class="mention" style=${{ color: nameColor(name) }} onClick=${() => name !== S.me.name && address(name)}>${word}</button>`;
    }
    if (!node) continue;
    out.push(html`<span class=${cls} style=${st}>${text.slice(last, m.index)}</span>`, node);
    last = m.index + word.length;
  }
  out.push(html`<span class=${cls} style=${st}>${text.slice(last)}</span>`);
  return out;
};

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^(\s*)>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/// A message body: a list keeps its hanging indent, code its colour, a quote its bar.
const Body = ({ text, msg, control }) => {
  const lines = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return;
    }
    const hang = (lead, kids, cls = '') => html`<div key=${i} class="line hang ${cls}" style=${{ '--hang': `${lead.length}ch` }}>${kids}</div>`;
    if (fenced) lines.push(html`<div key=${i} class="line" style="white-space: pre; overflow-x: auto"><span class="code">${'  ' + raw.replace(/\t/g, '  ')}</span></div>`);
    else if (raw.trim() === '') lines.push(html`<div key=${i} class="line"></div>`);
    else if (RULE.test(raw)) lines.push(html`<div key=${i} class="line"><span class="rule">${'─'.repeat(40)}</span></div>`);
    else if (HEADING.test(raw)) lines.push(html`<div key=${i} class="line">${inline(HEADING.exec(raw)[2], msg, { bold: true })}</div>`);
    else if (QUOTE.test(raw)) {
      const q = QUOTE.exec(raw);
      const lead = `${q[1]}│ `;
      lines.push(hang(lead, [html`<span class="quote">${lead}</span>`, ...inline(q[2], msg, { muted: true })]));
    } else if (ORDERED.test(raw) || BULLET.test(raw)) {
      const [, pad, mark, rest] = ORDERED.exec(raw) || BULLET.exec(raw);
      const ordered = /^\d/.test(mark);
      const lead = `${pad}${ordered ? mark : '·'} `;
      lines.push(hang(lead, [html`<span class=${ordered ? '' : 'bullet'}>${lead}</span>`, ...inline(rest, msg)]));
    } else {
      const pad = /^\s*/.exec(raw)[0];
      lines.push(pad ? hang(pad, [html`<span>${pad}</span>`, ...inline(raw.slice(pad.length), msg)]) : html`<div key=${i} class="line">${inline(raw, msg)}</div>`);
    }
  });
  return html`<div class="body ${control ? 'accent' : ''}">${lines}</div>`;
};

// MARK: the conversation

const Name = ({ name }) => html`<button type="button" class="name" style=${{ color: nameColor(name) }} onClick=${() => name !== S.me.name && address(name)}>${name}</button>`;

const FORWARDED = /^\[forwarded from ([^\]]+)\]\s*/;

const Banner = () => html`<div class="entry banner">
  <div><span class="b primary">metacom</span><span class="muted"> · </span><span class="b">${S.room}</span><span class="muted"> at ${location.host} as </span><${Name} name=${S.me.name} /><span class="muted"> (${S.me.role}) · web</span></div>
  <span class="muted">@Name to address an agent · / for commands · /help for keys</span>
</div>`;

const MessageView = ({ msg, grouped, tight }) => {
  if (msg.kind === 'system') return html`<div class="entry system muted">· ${msg.text}  ${time(msg.ts)}</div>`;
  const from = msg.from?.name ?? '?';
  const control = msg.kind === 'control';
  const forwarded = FORWARDED.exec(msg.text);
  const reply = () => {
    const who = from !== S.me.name ? from : msg.to && msg.to !== S.me.name ? msg.to : null;
    if (who) address(who);
  };
  return html`<div class="entry message" style=${tight ? 'margin-bottom: 0' : ''}>
    ${!grouped &&
    html`<div class="head">
      <${Name} name=${from} />
      ${msg.to && html`<span class="arrow" style=${{ color: control ? 'var(--accent)' : msg.kind === 'info' ? 'var(--muted)' : 'var(--fg)' }}>${control ? '⌘' : '→'}</span><${Name} name=${msg.to} />`}
      <span class="muted">${`  ${time(msg.ts)}${forwarded ? `  [forwarded from ${forwarded[1]}]` : ''}`}</span>
    </div>`}
    <${Body} text=${msg.text.replace(FORWARDED, '')} msg=${msg} control=${control} />
    <div class="actions">
      <button type="button" onClick=${reply}>↩ reply</button>
      <button type="button" onClick=${() => startForward(msg)}>↪ forward</button>
      ${(msg.media || []).map((f) => html`<a href=${f.url} target="_blank" rel="noopener" style="color: var(--muted); margin-right: 2ch; text-decoration: none">↗ ${f.name.length > 32 ? f.name.slice(0, 31) + '…' : f.name}</a>`)}
    </div>
  </div>`;
};

const Note = ({ text, tone, ts }) => html`<div class="entry system muted"><span style=${{ color: tone === 'error' ? 'var(--error)' : 'var(--warning)' }}>·</span> ${text}  ${time(ts)}</div>`;

const Block = ({ block }) => html`<div class="entry block">${block}</div>`;

const Feed = () => {
  const s = useStore();
  const ref = useRef(null);
  const stick = useRef(true);
  // before the browser paints: at the end when a room was just opened, or when the reader was
  // already there — so a room appears at its end, never scrolling down into view
  useLayoutEffect(() => {
    const f = ref.current;
    if (!f) return;
    const opened = S.scrollEnd;
    if (opened) {
      S.scrollEnd = false;
      stick.current = true;
    }
    if (!stick.current) return;
    f.scrollTop = f.scrollHeight;
    // and again once the layout has settled: the first frame and the web font can still change
    // how tall the conversation is
    if (opened) {
      requestAnimationFrame(() => stick.current && (f.scrollTop = f.scrollHeight));
      document.fonts?.ready.then(() => stick.current && (f.scrollTop = f.scrollHeight));
    }
  });
  const onScroll = () => {
    const f = ref.current;
    stick.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
  };
  return html`<div id="feed" ref=${ref} onScroll=${onScroll}>
    <div class="spacer"></div>
    ${s.log.map((e, i) => {
      const next = s.log[i + 1];
      if (e.type === 'banner') return html`<${Banner} key=${e.id} />`;
      if (e.type === 'message') return html`<${MessageView} key=${e.id} msg=${e.msg} grouped=${e.grouped} tight=${next && next.type === 'message' && next.grouped} />`;
      if (e.type === 'note') return html`<${Note} key=${e.id} ...${e} />`;
      if (e.type === 'rule') return html`<div key=${e.id} class="entry rule-now">${'─'.repeat(24)} now</div>`;
      return html`<${Block} key=${e.id} block=${e.block} />`;
    })}
  </div>`;
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

// Consecutive messages from one sender within two minutes drop the repeated time and name.
const grouped = (m) => {
  if (m.kind === 'system') {
    lastMessage.current = null;
    return false;
  }
  const from = m.from?.name ?? '?';
  const ts = Date.parse(m.ts);
  const last = lastMessage.current;
  const g = Boolean(last && last.name === from && !m.to && !last.to && ts - last.ts < 120000);
  lastMessage.current = { name: from, ts, to: m.to };
  return g;
};
const pushMessage = (m) => push({ type: 'message', msg: m, grouped: grouped(m) });

const note = (text, tone = 'warn') => {
  // warnings and errors stay in the conversation; the rest is said under the input a moment
  if (tone !== 'warn' && tone !== 'error') return setStatus(text, tone === 'dim' ? 'plain' : tone, 4000);
  lastMessage.current = null;
  push({ type: 'note', text, tone, ts: new Date().toISOString() });
};

/// A room's conversation, built whole: banner, the last 30 real messages, the "now" rule.
const conversation = (history) => {
  lastMessage.current = null;
  const list = foldReconnects(history).slice(-30);
  const entries = [{ type: 'banner' }, ...list.map((m) => ({ type: 'message', msg: m, grouped: grouped(m) })), ...(list.length ? [{ type: 'rule' }] : [])];
  return entries.map((e) => ({ ...e, id: `e${++seq}` }));
};

// The room's history, fetched before anything changes on screen, then shown in one step and at
// its end: no empty feed, no messages arriving one by one, no scrolling down into view.
const load = async () => {
  const history = await S.hub.call('room/history', { room: S.room, limit: 300 });
  set({ log: conversation(history), scrollEnd: true });
  markRead();
};

let readTimer = null;
const markRead = () => {
  if (readTimer) return;
  readTimer = setTimeout(() => {
    readTimer = null;
    S.hub.call('room/read', { room: S.room }).catch(() => {});
  }, 1000);
};

// MARK: the line above the input

const StatusBar = () => {
  const s = useStore();
  const list = [...s.members.values()]
    .filter((m) => m.name !== s.me.name && m.connected)
    .sort((a, b) => (stateOf(a) === 'working' ? 0 : 1) - (stateOf(b) === 'working' ? 0 : 1) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || a.name.localeCompare(b.name));
  return html`<div id="status">
    <span class="who">
      ${!list.length && html`<span class="muted">nobody else here</span>`}
      ${list.map((m) => {
        const st = stateOf(m);
        const glyph = m.kind === 'human' ? '◆' : st === 'working' ? SPIN[s.frame % SPIN.length] : '●';
        return html`<button key=${m.name} type="button" onClick=${() => address(m.name)}><span style="color: var(--success)">${glyph}</span> <span style=${{ color: nameColor(m.name) }}>${m.name}</span>${st === 'working' && html`<span class="muted"> working</span>`}</button>`;
      })}
    </span>
    <span class="me">${s.me.name} · <span class="room">${s.room}</span></span>
  </div>`;
};
setInterval(() => {
  if ([...S.members.values()].some((m) => m.connected && m.status === 'working') || S.busy) set({ frame: S.frame + 1 });
}, 80);

// MARK: the hint under the input

let statusTimer = null;
const setStatus = (text, tone = 'ok', ms = 0) => {
  clearTimeout(statusTimer);
  set({ status: text ? { text, tone } : null });
  if (text && ms) statusTimer = setTimeout(() => set({ status: null }), ms);
};
const setBusy = (busy) => set({ busy });

const CONTROL = /^!(?:(?:cancel|esc|stop|keys|type)\b|\/)/;
const hintOf = (s) => {
  if (s.status) {
    const t = s.status.tone;
    return [t === 'warn' ? 'warning' : t === 'error' ? 'error' : t === 'plain' ? 'muted' : 'success', s.status.text];
  }
  if (s.busy) return ['', html`<span class="primary">${SPIN[s.frame % SPIN.length]}</span> ${s.busy}`];
  if (s.picker) return ['muted', 'filter or new room · ↑↓ enter · esc back'];
  const text = s.text;
  const pending = s.files.filter((f) => text.includes(f.token)).length;
  const files = pending ? ` with ${pending} file${pending > 1 ? 's' : ''}` : '';
  if (!text) return ['muted', '@ to address an agent · / for commands · shift+enter new line · /help'];
  const mentions = [...text.matchAll(/(^|\s)@([^\s]+)/g)].map((m) => m[2].replace(/[.,:;!?]+$/, ''));
  const head = mentions.find((n) => s.members.has(n)) ?? (text.startsWith('@') ? mentions[0] : undefined);
  if (head) {
    const m = s.members.get(head);
    if (!m) return ['', html`<span class="warning">nobody called ${head} is in this room</span><span class="muted"> · /say to post it anyway</span>`];
    return ['muted', m.kind === 'agent' ? `enter types this${files} into ${m.name}${m.connected ? '' : ' when it comes back'}` : `enter sends this${files} to ${m.name} directly`];
  }
  if (text.startsWith('/')) return ['muted', 'enter runs the command'];
  if (CONTROL.test(text)) return ['warning', 'control commands go to an agent: @Alex !cancel'];
  return ['muted', `enter posts to ${s.room}${files}`];
};

const Footer = () => {
  const s = useStore();
  const [cls, hint] = hintOf(s);
  return html`<div id="footer">
    <button id="roomsBtn" type="button" onMouseDown=${(e) => e.preventDefault()} onClick=${() => (S.picker ? closePicker() : openPicker())}>${s.picker ? '× close' : '← rooms'}</button>
    <span id="hint" class=${cls}>${hint}</span>
  </div>`;
};

// MARK: the input and the list over it

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

// Members after "@", commands after a leading "/" — or, while forwarding, whom to.
const computePopup = (text, caret) => {
  const upto = text.slice(0, caret);
  if (S.forward) {
    const q = text.replace(/^@/, '').toLowerCase();
    return { kind: 'mention', items: [...S.members.values()].filter((m) => m.name !== S.me.name && m.name.toLowerCase().includes(q)).map((m) => ({ label: m.name, member: m })) };
  }
  const at = /(^|\s)@([^\s]*)$/.exec(upto);
  if (at) {
    const q = at[2].toLowerCase();
    const items = [...S.members.values()]
      .filter((m) => m.name !== S.me.name && m.name.toLowerCase().includes(q))
      .sort((a, b) => (a.connected === b.connected ? 0 : a.connected ? -1 : 1) || a.name.localeCompare(b.name))
      .map((m) => ({ label: m.name, member: m }));
    return { kind: 'mention', items };
  }
  const cmd = /^\/(\S*)$/.exec(upto);
  if (cmd) return { kind: 'command', items: COMMANDS.filter((c) => c.name.startsWith(cmd[1].toLowerCase())).map((c) => ({ label: c.name, command: c })) };
  return { kind: null, items: [] };
};

const Popup = () => {
  const s = useStore();
  const p = s.popup;
  if (s.picker || !p.kind || !p.items.length) return html`<div id="popup"></div>`;
  const rows = 6;
  const top = Math.max(0, Math.min(p.index - rows + 1, p.items.length - rows));
  const nameW = Math.max(6, ...p.items.map((i) => i.label.length)) + 1;
  return html`<div id="popup" class="open">
    ${p.items.slice(top, top + rows).map((item, i) => {
      const active = top + i === p.index;
      const onClick = () => {
        set({ popup: { ...S.popup, index: top + i } });
        choose();
      };
      let rest;
      if (p.kind === 'mention') {
        const m = item.member;
        const st = m.kind === 'route' ? 'the hub picks an agent' : stateOf(m);
        const glyph = m.kind === 'route' ? '◎' : m.kind === 'human' ? (m.connected ? '◆' : '◇') : st === 'offline' ? '○' : '●';
        rest = html`<span style=${{ color: m.kind === 'route' ? 'var(--accent)' : st === 'offline' ? 'var(--muted)' : 'var(--success)' }}>${glyph}</span> <span class="label" style=${{ color: nameColor(m.name) }}>${('@' + item.label).padEnd(nameW)}</span> <span class="muted">${st.padEnd(9)}</span> <span class="muted">${[m.host ? '@' + m.host : '', m.repo || ''].filter(Boolean).join('  ')}</span>`;
      } else {
        const c = item.command;
        rest = html`<span class="label" style=${{ color: active ? 'var(--primary)' : 'var(--fg)' }}>${('/' + c.name).padEnd(nameW)}</span> <span class="muted">${c.args.padEnd(28)}</span> <span class="muted">${c.help}</span>`;
      }
      return html`<button key=${item.label} type="button" class="item ${active ? 'active' : ''}" onMouseDown=${(e) => e.preventDefault()} onClick=${onClick}><span class="mark">${active ? '›' : ' '}</span>${rest}</button>`;
    })}
    <span class="hint">${`  ↑↓ choose · tab inserts · esc closes${p.items.length > rows ? ` · ${p.items.length} matches` : ''}`}</span>
  </div>`;
};

/// Set the text from code (a name addressed, a choice inserted), caret where it belongs.
const setText = (text, caret = text.length) => {
  onText(text, caret);
  set({ caret });
};

const onText = (text, caret) => {
  if (S.picker) return set({ text, picker: { index: 0 } });
  const next = computePopup(text, caret);
  const same = next.kind === S.popup.kind && next.items.length === S.popup.items.length;
  set({ text, popup: { ...next, index: same ? Math.min(S.popup.index, Math.max(0, next.items.length - 1)) : 0 } });
};

const address = (name) => {
  setText(`@${name} ` + S.text.replace(/^@\S*\s*/, ''));
  focusInput();
};
const focusInput = () => document.getElementById('text')?.focus();

const choose = () => {
  const p = S.popup;
  const item = p.items[p.index];
  if (!item) return;
  if (S.forward && p.kind === 'mention') {
    const held = S.forward;
    set({ forward: null });
    setText('');
    return forward(held, item.member);
  }
  const input = document.getElementById('text');
  const caret = input ? input.selectionStart : S.text.length;
  const upto = S.text.slice(0, caret);
  const rest = S.text.slice(caret);
  const insert = p.kind === 'mention' ? `@${item.label} ` : `/${item.label} `;
  const start = p.kind === 'mention' ? upto.replace(/@[^\s]*$/, '') : '';
  setText(start + insert + rest.replace(/^\S*/, ''), (start + insert).length);
};

const Composer = () => {
  const s = useStore();
  const ref = useRef(null);
  // after text set from code: the caret where it belongs, and the box as tall as its lines
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    if (s.caret !== null) {
      t.setSelectionRange(s.caret, s.caret);
      S.caret = null;
    }
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 'px';
    placeCursor();
  });
  // the block cursor follows the caret wherever it goes: typing, clicks, arrows, selection
  useEffect(() => {
    const t = ref.current;
    const moved = () => placeCursor(true);
    document.addEventListener('selectionchange', moved);
    for (const ev of ['focus', 'blur', 'scroll', 'keyup']) t.addEventListener(ev, moved);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('selectionchange', moved);
      window.removeEventListener('resize', moved);
    };
  }, []);
  // a phone has the rooms link under the input and little width: the short form
  const narrow = window.innerWidth < 640;
  const placeholder = s.picker ? 'filter or new room · ↑↓ enter · esc back' : narrow ? `message ${s.room} · @ agents · / commands` : `message ${s.room} · @ for agents · / for commands · ← rooms`;
  const onPaste = (e) => {
    const items = [...(e.clipboardData ? e.clipboardData.items : [])].filter((it) => it.kind === 'file');
    if (!items.length) return;
    e.preventDefault();
    for (const it of items) attach(it.getAsFile());
  };
  return html`<div id="composer">
    <span class="prompt" style=${{ color: nameColor(s.me.name) }}>❯</span>
    <textarea id="text" ref=${ref} rows="1" enterkeyhint="send" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder=${placeholder} value=${s.text}
      onInput=${(e) => onText(e.target.value, e.target.selectionStart)} onClick=${(e) => onText(e.target.value, e.target.selectionStart)} onKeyDown=${onKey} onPaste=${onPaste}></textarea>
    <div id="mirror" aria-hidden="true"></div>
    <div id="cursor" aria-hidden="true"></div>
  </div>`;
};

/// The terminal's block cursor over the textarea: a copy of the text up to the caret, laid out
/// in an invisible box of the same width and font, says where the caret is; the block goes
/// there. Solid for a moment after it moves, then it blinks, as a terminal's does.
let restTimer = null;
const placeCursor = (moved = false) => {
  const t = document.getElementById('text');
  const mirror = document.getElementById('mirror');
  const cursor = document.getElementById('cursor');
  if (!t || !mirror || !cursor) return;
  if (document.activeElement !== t || t.selectionStart !== t.selectionEnd) {
    cursor.classList.remove('on');
    return;
  }
  const at = t.selectionStart;
  mirror.style.width = t.clientWidth + 'px';
  mirror.style.left = t.offsetLeft + 'px';
  mirror.style.top = t.offsetTop + 'px';
  mirror.textContent = t.value.slice(0, at);
  const mark = document.createElement('span');
  // the character under the cursor, or a space at the end: the block is as wide as it
  mark.textContent = t.value.slice(at, at + 1).replace('\n', ' ') || ' ';
  mirror.append(mark);
  cursor.style.left = t.offsetLeft + mark.offsetLeft + 'px';
  cursor.style.top = t.offsetTop + mark.offsetTop - t.scrollTop + 'px';
  cursor.style.width = Math.max(mark.offsetWidth, 1) + 'px';
  cursor.classList.add('on');
  if (moved || !cursor.classList.contains('rest')) {
    cursor.classList.remove('rest');
    clearTimeout(restTimer);
    restTimer = setTimeout(() => cursor.classList.add('rest'), 500);
  }
};

const onKey = (e) => {
  const t = e.target;
  if (S.picker) return pickerKey(e);
  const p = S.popup;
  const open = p.kind && p.items.length;
  if (open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    return set({ popup: { ...p, index: (p.index + (e.key === 'ArrowUp' ? -1 : 1) + p.items.length) % p.items.length } });
  }
  if (open && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && (p.kind === 'mention' || !t.value.includes(' '))))) {
    e.preventDefault();
    return choose();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (S.forward) {
      set({ forward: null });
      setText('');
      return setStatus('forwarding cancelled', 'warn', 1500);
    }
    if (open) return set({ popup: { kind: null, items: [], index: 0 } });
    return setText('');
  }
  if (e.key === 'ArrowLeft' && !t.value) {
    e.preventDefault();
    return openPicker();
  }
  // ↑ on the first line walks back through what you sent, ↓ forward again; past the newest
  // comes back what you were typing before you went, as the terminal chat's editor does
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !t.value.slice(0, t.selectionStart).includes('\n') && S.history.length) {
    if (e.key === 'ArrowDown' && S.historyAt < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && S.historyAt < 0) S.draft = t.value;
    const at = e.key === 'ArrowUp' ? Math.min(S.history.length - 1, S.historyAt + 1) : S.historyAt - 1;
    set({ historyAt: at });
    return setText(at < 0 ? S.draft || '' : S.history[S.history.length - 1 - at]);
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (t.value.endsWith('\\')) return setText(t.value.slice(0, -1) + '\n');
    submit();
  }
};

// Files: pasted or dropped ones wait as a token in the text, "[image 1.png]", and go with the
// message if the token is still there when it is sent.
let imageSeq = 0;
const attach = (file) => {
  const name = file.name && file.name !== 'image.png' ? file.name : `image ${++imageSeq}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
  const token = `[${name}]`;
  set({ files: [...S.files, { token, file, name }] });
  const input = document.getElementById('text');
  const at = input ? input.selectionStart : S.text.length;
  setText(S.text.slice(0, at) + token + ' ' + S.text.slice(at), at + token.length + 1);
};
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) attach(f);
});
const pickFiles = () => {
  const i = document.createElement('input');
  i.type = 'file';
  i.multiple = true;
  i.onchange = () => {
    for (const f of i.files) attach(f);
  };
  i.click();
};

const upload = async (f) => {
  const res = await fetch('/media', {
    method: 'POST',
    headers: { 'Content-Type': f.file.type || 'application/octet-stream', Authorization: `Bearer ${S.hub.token}`, 'X-Name': encodeURIComponent(f.name) },
    body: f.file,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `upload failed (${res.status})`);
  return { ...(await res.json()), name: f.name };
};
const uploadAll = async (text) => {
  const list = S.files.filter((f) => text.includes(f.token)).sort((a, b) => text.indexOf(a.token) - text.indexOf(b.token));
  if (!list.length) return undefined;
  const out = [];
  for (const f of list) {
    setBusy(`uploading ${f.name}…`);
    out.push(await upload(f));
  }
  return out;
};

// MARK: sending, as the chat does it

const mentioned = (t) => {
  for (const m of t.matchAll(/(^|\s)@([^\s]+)/g)) {
    const name = m[2].replace(/[.,:;!?]+$/, '');
    if (S.members.has(name)) return name;
  }
  return t.startsWith('@') ? t.slice(1).split(/\s/)[0] : null;
};

const submit = async () => {
  const t = S.text.trim();
  if (!t) return;
  const draft = S.text;
  set({ history: [...S.history, t], historyAt: -1 });
  setText('');
  setBusy('sending…');
  try {
    if (t.startsWith('/')) await command(t);
    else if (mentioned(t)) await directed(t);
    else if (t.startsWith('>')) await dispatch(t.slice(1).trim());
    else if (CONTROL.test(t)) note('control commands go to an agent, e.g. @Alex !cancel', 'warn');
    else await S.hub.call('room/say', { room: S.room, text: t, media: await uploadAll(t) });
    set({ files: S.files.filter((f) => S.text.includes(f.token)) });
  } catch (error) {
    setText(draft);
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
  const member = S.members.get(to);
  if (!member) {
    await S.hub.call('room/say', { room: S.room, text: t });
    return note(`posted to the room as text (nobody called ${to} is here)`, 'dim');
  }
  if (!body) return note(`say something after @${to}`, 'warn');
  const kind = member.kind === 'agent' ? 'command' : 'info';
  const r = await S.hub.call('agents/send', { to, text: body, kind, media: await uploadAll(body) });
  if (!r.delivered) note(`${to} is offline, queued until it is back`, 'dim');
};

const dispatch = async (body) => {
  if (!body) return note('say what to do after @auto', 'warn');
  const r = await S.hub.call('agents/dispatch', { text: body, room: S.room, media: await uploadAll(body) });
  note(`the hub picked ${r.agent} (${r.reason})${r.delivered ? '' : ', queued'}`, 'dim');
};

const startForward = (msg) => {
  set({ forward: msg });
  setText('@');
  focusInput();
  setStatus(`forwarding ${msg.from?.name ?? '?'}'s message · pick who · esc cancels`, 'ok');
};
const forward = async (msg, member) => {
  const body = `[forwarded from ${msg.from?.name ?? '?'}${msg.to ? ` → ${msg.to}` : ''}] ${msg.text}`;
  try {
    const r = await S.hub.call('agents/send', { to: member.name, text: body, kind: member.kind === 'agent' ? 'command' : 'info', media: msg.media });
    setStatus(r.delivered ? `forwarded to ${member.name}` : `${member.name} is offline, queued`, 'ok', 2500);
  } catch (error) {
    failure(error);
  }
};

// MARK: commands

const Row = (k, v) => html`<div><span>${k.padEnd(34)}</span><span class="muted">${v}</span></div>`;
const Glyph = (m) => {
  const st = stateOf(m);
  return html`<span style=${{ color: st === 'offline' ? 'var(--muted)' : 'var(--success)' }}>${m.kind === 'human' ? (m.connected ? '◆' : '◇') : st === 'offline' ? '○' : '●'}</span>`;
};

const command = async (t) => {
  const [cmd, ...rest] = t.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const call = (m, a) => S.hub.call(m, a);
  const block = (b) => push({ type: 'block', block: b });
  switch (cmd) {
    case 'help':
      return block(html`<div>
        <span class="b primary">messages</span>
        ${Row('text', 'post to the room; @Name inside is a mention')}${Row('@Alex do the thing', 'typed into that agent when it is idle')}${Row('@Alex !cancel  !keys y  !/compact', 'control an agent; acts at once')}
        <span class="b primary">commands</span>
        ${COMMANDS.map((c) => Row(`/${c.name} ${c.args}`, c.help))}
        <span class="b primary">keys</span>
        ${Row('enter', 'send · shift+enter for a new line')}${Row('@ and /', 'open a list; ↑↓ choose, tab or enter inserts, esc closes')}${Row('↑ ↓', 'through what you sent')}${Row('← on an empty line', 'the room list (or the rooms button)')}${Row('tap', 'a name addresses it · ↩ reply and ↪ forward act on a message')}
      </div>`);
    case 'agents':
    case 'who': {
      const members = [...S.members.values()];
      if (!members.length) return note('nobody here', 'dim');
      const nameW = Math.max(6, ...members.map((m) => m.name.length));
      return block(html`<div>${members.map(
        (m) => html`<div>${Glyph(m)} <span class="b" style=${{ color: nameColor(m.name) }}>${m.name.padEnd(nameW)}</span> <span class="muted">${stateOf(m).padEnd(8)}</span> <span class="muted">${[m.host ? '@' + m.host : '', m.repo || '', m.kind === 'agent' && m.accept ? 'accepts ' + (Array.isArray(m.accept) ? m.accept.join(',') : m.accept) : ''].filter(Boolean).join('  ')}</span></div>`,
      )}</div>`);
    }
    case 'read': {
      const [name, n] = rest;
      if (!name) return note('usage: /read <name> [lines]', 'warn');
      const r = await call('agents/read', { name, lines: Number(n) || 30 });
      return block(html`<div><span class="muted">── ${name} screen ──</span><div class="screen">${r.text.replace(/\s+$/, '')}</div></div>`);
    }
    case 'wait': {
      const [name] = rest;
      if (!name) return note('usage: /wait <name>', 'warn');
      setBusy(`waiting for ${name}…`);
      const r = await call('agents/wait', { name, timeoutMs: 600000 });
      return note(r.timeout ? `still waiting, ${name} is ${r.status}` : `${name} is ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}`, r.status === 'blocked' ? 'warn' : 'ok');
    }
    case 'seen':
      if (!rest[0]) return note('usage: /seen <name>', 'warn');
      return call('agents/seen', { name: rest[0] });
    case 'cancel':
      if (!rest[0]) return note('usage: /cancel <name>', 'warn');
      return call('agents/send', { to: rest[0], text: '!cancel', kind: 'command' });
    case 'keys': {
      const [name, ...keys] = rest;
      if (!name || !keys.length) return note('usage: /keys <name> enter|esc|up|down|y', 'warn');
      return call('agents/send', { to: name, text: `!keys ${keys.join(' ')}`, kind: 'command' });
    }
    case 'say':
      if (!arg) return note('usage: /say <text>', 'warn');
      return call('room/say', { room: S.room, text: arg, media: await uploadAll(arg) });
    case 'attach':
      return pickFiles();
    case 'rooms':
      return openPicker();
    case 'room':
      if (!arg) return note('usage: /room <name> · or ← on an empty line for the list', 'warn');
      return switchRoom(arg);
    case 'clear':
      lastMessage.current = null;
      return set({ log: [] });
    default:
      return note(`unknown command /${cmd} · /help lists them`, 'warn');
  }
};

// MARK: rooms

const ROOM = /^[\w][\w.-]{0,63}$/;
const pickerItems = () => {
  const q = S.text.trim();
  const shown = S.rooms.filter((r) => ROOM.test(r.room) && r.room.toLowerCase().includes(q.toLowerCase())).map((r) => ({ room: r.room, summary: r }));
  if (!S.rooms.some((r) => r.room === S.room) && S.room.includes(q)) shown.unshift({ room: S.room });
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

const RoomPicker = () => {
  const s = useStore();
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  const items = pickerItems();
  const at = Math.min(s.picker.index, Math.max(0, items.length - 1));
  const nameW = Math.min(28, Math.max(8, ...items.map((i) => i.room.length + 2)));
  return html`<div id="rooms" ref=${ref} style=${{ '--nameW': `${nameW}ch` }}>
    <div class="title">rooms</div>
    ${!items.length && html`<span class="muted">${s.rooms.length ? 'no room matches · type a name to create one' : 'loading…'}</span>`}
    ${items.map(
      (item, i) => html`<button key=${item.room} type="button" class="row ${i === at ? 'active' : ''}" onMouseDown=${(e) => e.preventDefault()} onClick=${() => pick(item)}>
        <span class="mark">${i === at ? '›' : ' '}</span>
        ${item.create
          ? html`<span class=${i === at ? 'b primary' : ''}>+ create ${item.room}</span>`
          : html`<span class="room">${item.room}</span><span class="muted">${counts(item.summary)}</span>${item.summary?.unread ? html`<span class="b warning"> · ${item.summary.unread} unread</span>` : ''}${item.room === s.room ? html`<span class="muted">  · you are here</span>` : ''}`}
      </button>`,
    )}
  </div>`;
};

const openPicker = async () => {
  set({ picker: { index: 0 }, popup: { kind: null, items: [], index: 0 } });
  setText('');
  const rooms = await S.hub.call('room/list', {}).catch(() => S.rooms);
  set({ rooms });
  set({ picker: { index: Math.max(0, pickerItems().findIndex((i) => i.room === S.room)) } });
  focusInput();
};
const closePicker = () => {
  set({ picker: null });
  setText('');
};
// the list stays until the room is ready, then the room replaces it in one step
const pick = async (item) => {
  if (item.room === S.room) return closePicker();
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
    return set({ picker: { index: (Math.min(S.picker.index, items.length - 1) + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length } });
  }
  if (e.key === 'Enter' || (e.key === 'ArrowRight' && e.target.selectionStart >= e.target.value.length)) {
    e.preventDefault();
    const item = items[Math.min(S.picker.index, items.length - 1)];
    if (item) pick(item);
  }
};

// Another room: joined and its history fetched while this one (or the room list) stays on
// screen, then room, members, conversation and address change in one render, at its end.
const switchRoom = async (room, { fromHistory = false } = {}) => {
  if (room === S.room) return;
  if (!ROOM.test(room)) return note('a room name is letters, digits, dot, dash or underscore', 'warn');
  const [history] = await Promise.all([S.hub.call('room/history', { room, limit: 300 }), join(room)]);
  saved.set('tui.room', room);
  if (!fromHistory) showRoom(room);
  S.room = room;
  set({ room, members: roomMembers(S.all), log: conversation(history), scrollEnd: true, picker: null, text: '', popup: { kind: null, items: [], index: 0 } });
  markRead();
};

// MARK: members

const roomMembers = (list) => new Map(list.filter((m) => m.room === S.room).map((m) => [m.name, m]));
const members = (list) => set({ all: list, members: roomMembers(list) });

const join = async (room = S.room) => {
  await S.hub.call('agents/register', { name: S.me.name, room, kind: 'human', host: 'web' });
  await S.hub.call('room/join', { room });
  await S.hub.call('agents/status', { status: 'waiting' }).catch(() => {});
};

// MARK: sign in

const Login = () => {
  const s = useStore();
  const token = useRef(null);
  const name = useRef(null);
  const go = () => signIn(token.current.value.trim(), name.current.value.trim());
  const enter = (e) => e.key === 'Enter' && go();
  return html`<div id="login">
    <div><span class="b primary">metacom</span><span class="muted"> · sign in</span></div>
    <label class="field"><span class="prompt">❯</span><input id="token" ref=${token} type="password" placeholder="token" autocomplete="off" autocapitalize="off" spellcheck="false" value=${saved.get('tui.token') || saved.get('hub.token') || ''} onKeyDown=${enter} /></label>
    <label class="field"><span class="prompt">❯</span><input id="name" ref=${name} placeholder="your name, e.g. misha" autocomplete="off" autocapitalize="off" spellcheck="false" value=${saved.get('tui.name') || ''} onKeyDown=${enter} /></label>
    <button id="loginBtn" class="go" type="button" onClick=${go}>connect ⏎</button>
    <div id="loginError">${s.loginError}</div>
  </div>`;
};

// sign in with the token and the name you go by in the rooms, both remembered on this device
const signIn = async (token, name) => {
  if (!token || !/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name)) return set({ loginError: !token ? 'a token, please' : 'a name: letters, digits, dot, dash, underscore' });
  set({ loginError: '' });
  const hub = new Hub((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/', token);
  let first = true;
  hub.onOpen = async (me) => {
    set({ me: { name, role: me.role } });
    if (!first) {
      await join();
      members(await hub.call('agents/list', {}));
    }
  };
  hub.onState = (on) => setBusy(on ? null : 'reconnecting…');
  hub.on('room/message', (m) => {
    if (m.room && m.room !== S.room) return;
    pushMessage(m);
    if (m.to === S.me.name) markRead();
  });
  hub.on('agents/changed', ({ members: list }) => members(list));
  set({ hub });
  try {
    await hub.connect();
    first = false;
    await join();
    members(await hub.call('agents/list', {}));
    await load();
    saved.set('tui.token', token);
    saved.set('tui.name', name);
    set({ signedIn: true });
    showRoom(S.room, true);
    focusInput();
  } catch (error) {
    hub.token = null;
    set({ loginError: error.message, hub: null });
  }
};

// MARK: the page

const App = () => {
  const s = useStore();
  useEffect(() => {
    document.body.classList.toggle('picking', Boolean(s.picker));
  });
  if (!s.signedIn) return html`<${Login} />`;
  return html`
    ${s.picker ? html`<${RoomPicker} />` : html`<${Feed} />`}
    <${StatusBar} />
    <${Popup} />
    <${Composer} />
    <${Footer} />
  `;
};

render(html`<${App} />`, document.getElementById('app'));
// ← anywhere on the page, when no field is being typed in, opens the room list, as ← on an
// empty input does
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;
  if (!S.signedIn || S.picker) return;
  e.preventDefault();
  openPicker();
});
// back and forward between rooms
window.addEventListener('popstate', () => {
  const room = pathRoom();
  if (room && S.signedIn && room !== S.room) {
    if (S.picker) closePicker();
    switchRoom(room, { fromHistory: true });
  }
});
if (saved.get('tui.token') && saved.get('tui.name')) signIn(saved.get('tui.token'), saved.get('tui.name'));

// Phones: the on-screen keyboard shrinks the visual viewport, not the layout one (iOS), so the
// page is sized to the visual viewport and moved with it; the input stays just above the
// keyboard, and a conversation that was at its end stays at its end.
const vv = window.visualViewport;
const fit = () => {
  if (!vv) return;
  const feed = document.getElementById('feed');
  const atEnd = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const st = document.documentElement.style;
  st.setProperty('--vh', Math.round(vv.height) + 'px');
  st.setProperty('--vv-top', Math.round(vv.offsetTop) + 'px');
  document.body.classList.toggle('keyboard', window.innerHeight - vv.height > 120);
  if (feed && atEnd) requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
};
// focusing the input brings the keyboard up: follow it as it opens
document.addEventListener('focusin', () => setTimeout(fit, 250));
document.addEventListener('focusout', () => setTimeout(fit, 250));
if (vv) {
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}
window.addEventListener('scroll', () => {
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
});
