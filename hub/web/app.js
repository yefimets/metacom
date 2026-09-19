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

const state = { hub: null, room: null, members: [], me: null };
const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/';

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
    const card = el('div', `agent ${m.connected ? m.status : 'stopped'}${done ? ' done' : ''}`);
    const title = el('b');
    title.append(el('i'), document.createTextNode(m.name));
    if (m.connected && m.status === 'blocked') title.append(el('em', '', 'needs you'));
    else if (done) title.append(el('em', '', 'done'));
    card.append(title, el('small', '', `${m.connected ? m.status : 'offline'}${m.host ? ' · ' + m.host : ''}`));
    if (m.repo) card.append(el('small', '', m.repo.split('/').pop()));
    if (m.connected && m.status === 'blocked' && m.reason) card.append(el('small', '', m.reason.replace(/^screen: /, '')));
    const view = el('button', '', 'screen');
    view.type = 'button';
    view.onclick = (e) => {
      e.stopPropagation();
      openScreen(m.name);
    };
    if (m.connected) card.append(view);
    card.onclick = () => {
      target.value = m.name;
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
  $('screenText').textContent = '…';
  $('screen').classList.remove('hidden');
  try {
    const r = await state.hub.call('agents/read', { name, lines: 60 });
    $('screenText').textContent = r.text || '(empty)';
    $('screenText').scrollTop = $('screenText').scrollHeight;
    state.hub.call('agents/seen', { name }).catch(() => {});
  } catch (error) {
    $('screenText').textContent = error.message;
  }
};
$('screenClose').onclick = () => $('screen').classList.add('hidden');
$('screenRefresh').onclick = () => openScreen(state.screenAgent);
for (const b of document.querySelectorAll('#screen .keys button[data-cmd]')) {
  b.onclick = async () => {
    try {
      await state.hub.call('agents/send', { to: state.screenAgent, text: b.dataset.cmd, kind: 'command' });
      setTimeout(() => openScreen(state.screenAgent), 700);
    } catch (error) {
      alert(error.message);
    }
  };
}

const renderMessage = (m) => {
  if (m.kind === 'system') {
    const sys = el('div', 'msg system', `${m.ts.slice(11, 16)} · ${m.text}`);
    $('stream').append(sys);
    return;
  }
  const mine = state.me && m.from.name === state.me.name && m.from.role === 'owner';
  const node = el('div', `msg${mine ? ' mine' : ''}`);
  const meta = el('div', 'meta');
  meta.append(document.createTextNode(`${m.ts.slice(11, 16)} ${m.from.name}`));
  if (m.to) {
    meta.append(document.createTextNode(' → '));
    meta.append(el('span', 'to', m.to));
  }
  if (m.kind !== 'say' && m.kind !== 'command') meta.append(document.createTextNode(` [${m.kind}]`));
  node.append(meta, document.createTextNode(m.text));
  const stream = $('stream');
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40;
  stream.append(node);
  if (atBottom || mine) stream.scrollTop = stream.scrollHeight;
};

const loadRoom = async (room) => {
  state.room = room;
  try {
    localStorage.setItem('hub.room', room);
  } catch {
    // private mode
  }
  $('stream').replaceChildren();
  const history = await state.hub.call('room/history', { room, limit: 80 });
  for (const m of history) renderMessage(m);
  $('stream').scrollTop = $('stream').scrollHeight;
  renderAgents();
};

const start = async (token) => {
  const hub = new Hub(wsUrl(), token);
  state.hub = hub;
  hub.onState = (on) => $('dot').classList.toggle('on', on);
  hub.on('agents/changed', ({ members }) => {
    state.members = members;
    renderAgents();
  });
  hub.on('room/message', (m) => {
    if (m.room === state.room) renderMessage(m);
  });
  state.me = await hub.connect();
  await hub.call('agents/register', { name: state.me.name, kind: 'human', room: '*' }).catch(() => {});
  await hub.call('room/join', { room: '*' });
  state.members = await hub.call('agents/list', {});
  const rooms = (await hub.call('room/list', {})).map((r) => r.room);
  const select = $('room');
  select.replaceChildren(...rooms.map((r) => new Option(r, r)));
  let remembered = null;
  try {
    remembered = localStorage.getItem('hub.room');
  } catch {
    remembered = null;
  }
  const first = rooms.includes(remembered) ? remembered : rooms.find((r) => state.members.some((m) => m.room === r && m.kind === 'agent')) || rooms[0];
  select.value = first;
  select.onchange = () => loadRoom(select.value);
  await loadRoom(first);
  $('login').classList.add('hidden');
};

$('composer').onsubmit = async (event) => {
  event.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  const target = $('target').value;
  const button = $('send');
  button.disabled = true;
  try {
    if (target === 'room') await state.hub.call('room/say', { room: state.room, text });
    else if (target === 'auto') await state.hub.call('agents/dispatch', { text, room: state.room });
    else await state.hub.call('agents/send', { to: target, text, kind: 'command' });
    $('text').value = '';
  } catch (error) {
    alert(error.message);
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

$('loginBtn').onclick = async () => {
  const token = $('token').value.trim();
  if (!token) return;
  $('loginError').textContent = '';
  try {
    await start(token);
    try {
      localStorage.setItem('hub.token', token);
    } catch {
      // private mode: token lives for this page only
    }
  } catch (error) {
    $('loginError').textContent = error.message;
  }
};

let saved = null;
try {
  saved = localStorage.getItem('hub.token');
} catch {
  saved = null;
}
if (saved) start(saved).catch(() => $('login').classList.remove('hidden'));
