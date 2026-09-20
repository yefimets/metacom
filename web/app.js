'use strict';

// A metacom client small enough to live in one file: call packets get callbacks by id,
// event packets go to listeners by "unit/name". Reconnects and signs in again on drop.
class Hub {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.calls = new Map();
    this.listeners = new Map();
    this.ws = null;
    this.me = null;
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
          this.me = await this.call('auth/signin', { token: this.token });
          this.onState(true);
          resolve(this.me);
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
      }, 15000);
    });
  }

  close() {
    this.token = null;
    if (this.ws) this.ws.close();
  }
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const SVG = 'http://www.w3.org/2000/svg';
const mark = (cls) => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', '#mark');
  svg.append(use);
  return svg;
};

const state = { hub: null, room: null, members: [], me: null, screenAgent: null, pending: 0 };
const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/';

// The spinning mark in the corner while any call is in flight, and on the login screen
// while connecting. It is the same five-line mark as the logo.
const busy = (on) => {
  state.pending = Math.max(0, state.pending + (on ? 1 : -1));
  $('busy').classList.toggle('hidden', state.pending === 0);
};
const withBusy = async (fn) => {
  busy(true);
  try {
    return await fn();
  } finally {
    busy(false);
  }
};

let toastTimer = null;
const toast = (text) => {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
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
      // private mode: lives for this page only
    }
  },
  del: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore
    }
  },
};

const glyphFor = (m) => {
  if (!m.connected) return el('i', 'glyph stopped');
  if (m.status === 'working') {
    const g = el('i', 'glyph');
    g.append(mark('logo spin'));
    return g;
  }
  return el('i', `glyph ${m.status}`);
};

const renderAgents = () => {
  const box = $('agents');
  box.replaceChildren();
  const target = $('target');
  const keep = target.value;
  target.replaceChildren(new Option('auto', 'auto'), new Option('room', 'room'));
  const list = state.members.filter((m) => !state.room || m.room === state.room);
  for (const m of list) {
    if (m.kind !== 'agent') continue;
    const done = m.attention && m.status !== 'blocked';
    const status = m.connected ? m.status : 'stopped';
    const card = el('div', `agent ${status}${done ? ' done' : ''}${keep === m.name ? ' selected' : ''}`);
    const title = el('div', 'name');
    title.append(glyphFor(m), document.createTextNode(m.name));
    card.append(title);
    if (m.connected && m.status === 'blocked') card.append(el('span', 'tag', 'needs you'));
    else if (done) card.append(el('span', 'tag', 'done'));
    card.append(el('div', 'meta', `${status}${m.host ? ' @ ' + m.host : ''}`));
    if (m.repo) card.append(el('div', 'meta', m.repo.split('/').pop()));
    if (m.connected && m.status === 'blocked' && m.reason) card.append(el('div', 'meta', m.reason.replace(/^screen: /, '')));
    if (m.connected) {
      const row = el('div', 'row');
      const view = el('button', 'btn', 'screen');
      view.type = 'button';
      view.onclick = (e) => {
        e.stopPropagation();
        openScreen(m.name);
      };
      row.append(view);
      card.append(row);
    }
    card.onclick = () => {
      target.value = m.name;
      for (const c of box.children) c.classList.toggle('selected', c === card);
      $('text').focus();
      if (m.attention) state.hub.call('agents/seen', { name: m.name }).catch(() => {});
    };
    box.append(card);
    target.append(new Option(m.name, m.name));
  }
  if ([...target.options].some((o) => o.value === keep)) target.value = keep;
};

const openScreen = async (name) => {
  state.screenAgent = name;
  $('screenTitle').textContent = name;
  $('screen').classList.remove('hidden');
  try {
    const r = await withBusy(() => state.hub.call('agents/read', { name, lines: 80 }));
    $('screenText').textContent = r.text || '(empty)';
    $('screenText').scrollTop = $('screenText').scrollHeight;
    state.hub.call('agents/seen', { name }).catch(() => {});
  } catch (error) {
    $('screenText').textContent = error.message;
  }
};
$('screenClose').onclick = () => $('screen').classList.add('hidden');
$('screenRefresh').onclick = () => openScreen(state.screenAgent);
const sendCommand = async (text) => {
  try {
    await withBusy(() => state.hub.call('agents/send', { to: state.screenAgent, text, kind: 'command' }));
    setTimeout(() => openScreen(state.screenAgent), 700);
  } catch (error) {
    toast(error.message);
  }
};
for (const b of document.querySelectorAll('#screen .keys button[data-cmd]')) b.onclick = () => sendCommand(b.dataset.cmd);
$('screenType').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const text = $('screenType').value;
  if (!text) return;
  $('screenType').value = '';
  sendCommand(`!type ${text}`);
});

const renderMessage = (m) => {
  const stream = $('stream');
  const placeholder = stream.querySelector('.empty');
  if (placeholder) placeholder.remove();
  if (m.kind === 'system') {
    stream.append(el('div', 'msg system', `${m.ts.slice(11, 16)} ${m.text}`));
    return;
  }
  const mine = state.me && m.from.name === state.me.name && m.from.role === 'owner';
  const node = el('div', `msg${mine ? ' mine' : ''}`);
  const meta = el('div', 'meta');
  meta.append(document.createTextNode(`${m.ts.slice(11, 16)} `), el('span', 'from', m.from.name));
  if (m.to) meta.append(el('span', 'to', m.to));
  if (m.kind !== 'say' && m.kind !== 'command') meta.append(document.createTextNode(' '), el('span', 'kind', `[${m.kind}]`));
  node.append(meta, document.createTextNode(m.text));
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40;
  stream.append(node);
  if (atBottom || mine) stream.scrollTop = stream.scrollHeight;
};

const loadRoom = async (room) => {
  state.room = room;
  store.set('hub.room', room);
  $('stream').replaceChildren(el('div', 'empty', 'no messages'));
  const history = await withBusy(() => state.hub.call('room/history', { room, limit: 100 }));
  for (const m of history) renderMessage(m);
  $('stream').scrollTop = $('stream').scrollHeight;
  renderAgents();
};

const start = async (token) => {
  const hub = new Hub(wsUrl(), token);
  state.hub = hub;
  hub.onState = (on) => {
    $('state').textContent = on ? 'online' : 'offline';
    $('state').classList.toggle('on', on);
    $('headLogo').classList.toggle('spin', !on);
  };
  hub.on('agents/changed', ({ members }) => {
    state.members = members;
    renderAgents();
  });
  hub.on('room/message', (m) => {
    if (m.room === state.room) renderMessage(m);
  });
  $('loginLogo').classList.add('spin');
  try {
    state.me = await hub.connect();
  } finally {
    $('loginLogo').classList.remove('spin');
  }
  await hub.call('agents/register', { name: state.me.name, kind: 'human', room: '*' }).catch(() => {});
  await hub.call('room/join', { room: '*' });
  state.members = await hub.call('agents/list', {});
  const rooms = (await hub.call('room/list', {})).map((r) => r.room);
  const select = $('room');
  select.replaceChildren(...rooms.map((r) => new Option(r, r)));
  const remembered = store.get('hub.room');
  const first = rooms.includes(remembered) ? remembered : rooms.find((r) => state.members.some((m) => m.room === r && m.kind === 'agent')) || rooms[0];
  select.value = first;
  select.onchange = () => loadRoom(select.value);
  await loadRoom(first);
  $('login').classList.add('hidden');
};

const autosize = () => {
  const t = $('text');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px';
};
$('text').addEventListener('input', autosize);

$('composer').onsubmit = async (event) => {
  event.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  const target = $('target').value;
  const button = $('send');
  button.disabled = true;
  try {
    await withBusy(async () => {
      if (target === 'room') await state.hub.call('room/say', { room: state.room, text });
      else if (target === 'auto') await state.hub.call('agents/dispatch', { text, room: state.room });
      else await state.hub.call('agents/send', { to: target, text, kind: 'command' });
    });
    $('text').value = '';
    autosize();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    $('text').focus();
  }
};
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

const login = async () => {
  const token = $('token').value.trim();
  if (!token) return;
  $('loginError').textContent = '';
  $('loginBtn').disabled = true;
  try {
    await start(token);
    store.set('hub.token', token);
  } catch (error) {
    $('loginError').textContent = error.message;
  } finally {
    $('loginBtn').disabled = false;
  }
};
$('loginBtn').onclick = login;
$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});

// Long-press the header logo to forget the token and go back to the login screen.
let pressTimer = null;
$('headLogo').addEventListener('pointerdown', () => {
  pressTimer = setTimeout(() => {
    store.del('hub.token');
    if (state.hub) state.hub.close();
    $('token').value = '';
    $('login').classList.remove('hidden');
    toast('token forgotten');
  }, 1200);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('headLogo').addEventListener(ev, () => clearTimeout(pressTimer));

const saved = store.get('hub.token');
if (saved) start(saved).catch(() => $('login').classList.remove('hidden'));
