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

// Live agents first, the ones that need you before the rest; stopped ones trail.
const rank = (m) => (!m.connected ? 3 : m.status === 'blocked' ? 0 : m.attention ? 1 : 2);
const roomAgents = () =>
  state.members.filter((m) => m.kind === 'agent' && (!state.room || m.room === state.room)).sort((a, b) => rank(a) - rank(b));

// MARK: addressing. Like the terminal chat: a message that starts with "@Name" goes to that
// agent, "@room" is posted to the room, anything else (or "@auto") lets the hub pick.
const MENTION = /^@(\S+)\s*/;
const MENTION_OR_AT = /^@\S*\s*/; // also a bare "@" the popup is completing
const leadingMention = (text) => {
  const m = MENTION.exec(text);
  return m ? m[1] : '';
};
const setMention = (name) => {
  const t = $('text');
  const rest = t.value.replace(MENTION_OR_AT, '');
  t.value = name ? `@${name} ${rest}` : rest;
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
  onTextChange();
};

const renderAgents = () => {
  const box = $('agents');
  box.replaceChildren();
  const current = leadingMention($('text').value);
  for (const m of roomAgents()) {
    const done = m.attention && m.status !== 'blocked';
    const status = m.connected ? m.status : 'stopped';
    const card = el('div', `agent ${status}${done ? ' done' : ''}${current === m.name ? ' selected' : ''}`);
    card.dataset.name = m.name;
    const title = el('div', 'name');
    title.append(glyphFor(m), el('span', '', m.name));
    card.append(title);
    if (m.connected && m.status === 'blocked') card.append(el('span', 'tag', 'needs you'));
    else if (done) card.append(el('span', 'tag', 'done'));
    card.append(el('div', 'meta', `${status}${m.host ? ' @ ' + m.host : ''}`));
    if (m.accept && m.accept !== 'any') card.append(el('div', 'meta', `accepts ${Array.isArray(m.accept) ? m.accept.join(',') : m.accept}`));
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
      setMention(leadingMention($('text').value) === m.name ? '' : m.name);
      if (m.attention) state.hub.call('agents/seen', { name: m.name }).catch(() => {});
    };
    box.append(card);
  }
};

// The member list pops up over the input while the caret sits in a leading "@..." token.
const mentionChoices = () => {
  const fixed = [
    { name: 'auto', meta: 'hub picks an agent' },
    { name: 'room', meta: 'everyone' },
  ];
  const agents = roomAgents().map((m) => ({ name: m.name, meta: m.connected ? m.status : 'stopped' }));
  return [...fixed, ...agents];
};
const renderMention = () => {
  const box = $('mention');
  const t = $('text');
  const m = /^@(\S*)$/.exec(t.value.slice(0, t.selectionStart));
  if (!m || document.activeElement !== t) {
    box.classList.add('hidden');
    return;
  }
  const typed = m[1].toLowerCase();
  const list = mentionChoices().filter((c) => c.name.toLowerCase().startsWith(typed));
  box.replaceChildren();
  box.classList.toggle('hidden', list.length === 0);
  for (const c of list) {
    const b = el('button', c.name === leadingMention(t.value) ? 'current' : '');
    b.type = 'button';
    b.append(el('span', 'name', `@${c.name}`), el('span', 'meta', c.meta));
    // pointerdown: pick before the textarea loses focus and the list hides
    b.onpointerdown = (e) => {
      e.preventDefault();
      setMention(c.name);
      $('mention').classList.add('hidden');
    };
    box.append(b);
  }
};
const onTextChange = () => {
  const current = leadingMention($('text').value);
  for (const c of $('agents').children) c.classList.toggle('selected', c.dataset.name === current);
  renderMention();
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

// Attached files under a message: images inline, anything else as a link.
const renderMedia = (list) => {
  const box = el('div', 'media');
  for (const f of list) {
    const a = el('a');
    a.href = f.url;
    a.target = '_blank';
    a.rel = 'noopener';
    if (f.type.startsWith('image/')) {
      const img = el('img');
      img.src = f.url;
      img.alt = f.name;
      img.loading = 'lazy';
      img.onload = () => {
        if (scroll.pinned) scroll.toBottom();
      };
      a.append(img);
    } else {
      a.className = 'doc';
      a.textContent = f.name;
    }
    box.append(a);
  }
  return box;
};

// MARK: scrolling. The stream stays pinned to the bottom until the reader scrolls up; from
// then on new messages count up in a pill ("3 new") that jumps to the first of them.
const scroll = {
  pinned: true,
  unread: 0,
  first: null,
  atBottom() {
    const s = $('stream');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 40;
  },
  toBottom() {
    const s = $('stream');
    s.scrollTop = s.scrollHeight;
  },
  // after a render: once now, once more after layout (fonts, images with known size, the keyboard)
  settle() {
    this.toBottom();
    requestAnimationFrame(() => this.toBottom());
    setTimeout(() => this.toBottom(), 120);
  },
  arrived(node) {
    if (this.pinned) return this.toBottom();
    this.unread++;
    if (!this.first) this.first = node;
    this.pill();
  },
  seen() {
    this.unread = 0;
    this.first = null;
    this.pill();
  },
  pill() {
    const p = $('unread');
    p.textContent = this.unread ? `${this.unread} new ↓` : '';
    p.classList.toggle('hidden', this.unread === 0);
  },
  jump() {
    const target = this.first;
    if (target) target.scrollIntoView({ block: 'start' });
    else this.toBottom();
    if (this.atBottom()) this.seen();
    else this.first = null; // the next tap goes to the bottom
  },
};
$('stream').addEventListener('scroll', () => {
  scroll.pinned = scroll.atBottom();
  if (scroll.pinned) scroll.seen();
});
$('unread').onclick = () => scroll.jump();

const renderMessage = (m) => {
  const stream = $('stream');
  const placeholder = stream.querySelector('.empty');
  if (placeholder) placeholder.remove();
  if (m.kind === 'system') {
    stream.append(el('div', 'msg system', `${m.ts.slice(11, 16)} ${m.text}`));
    if (scroll.pinned) scroll.toBottom();
    return;
  }
  const mine = state.me && m.from.name === state.me.name && m.from.role === 'owner';
  const node = el('div', `msg${mine ? ' mine' : ''}`);
  const meta = el('div', 'meta');
  meta.append(document.createTextNode(`${m.ts.slice(11, 16)} `), el('span', 'from', m.from.name));
  if (m.to) meta.append(el('span', 'to', m.to));
  if (m.kind !== 'say' && m.kind !== 'command') meta.append(document.createTextNode(' '), el('span', 'kind', `[${m.kind}]`));
  node.append(meta, document.createTextNode(m.text));
  if (Array.isArray(m.media) && m.media.length) node.append(renderMedia(m.media));
  stream.append(node);
  if (mine) {
    scroll.pinned = true;
    scroll.seen();
  }
  scroll.arrived(node);
};

// MARK: attachments. Pasted, dropped or picked files wait in a strip above the input and
// are uploaded (POST /media with the token) when the message is sent.
const ACCEPT = /^(image\/(png|jpeg|gif|webp|heic|svg\+xml)|application\/(pdf|json|zip)|text\/(plain|markdown|csv))$/;
// browsers leave the type empty or vendor-specific for some of these; go by the extension
const BY_EXT = { md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip', log: 'text/plain', diff: 'text/plain', patch: 'text/plain', txt: 'text/plain' };
const files = [];
const renderFiles = () => {
  const box = $('files');
  box.replaceChildren();
  box.classList.toggle('hidden', files.length === 0);
  files.forEach((f, i) => {
    const card = el('div', 'file');
    card.title = f.file.name;
    if (f.file.type.startsWith('image/')) {
      const img = el('img');
      img.src = f.preview;
      img.alt = f.file.name;
      card.append(img);
    } else {
      card.append(el('span', 'ext', f.file.name.split('.').pop() || 'file'));
    }
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.onclick = () => removeFile(i);
    card.append(x);
    box.append(card);
  });
};
const addFile = (file) => {
  if (!file) return;
  const type = ACCEPT.test(file.type) ? file.type : BY_EXT[(file.name.split('.').pop() || '').toLowerCase()] || file.type;
  if (!ACCEPT.test(type)) return toast(`${file.name || 'file'}: images, pdf, text, csv, json and zip only`);
  if (file.size > 20 * 1024 * 1024) return toast(`${file.name}: larger than 20 MB`);
  if (files.length >= 8) return toast('at most 8 files per message');
  files.push({ file, type, preview: type.startsWith('image/') ? URL.createObjectURL(file) : null });
  renderFiles();
};
const removeFile = (i) => {
  const [f] = files.splice(i, 1);
  if (f && f.preview) URL.revokeObjectURL(f.preview);
  renderFiles();
};
const clearFiles = () => {
  while (files.length) removeFile(0);
};
const upload = async (f) => {
  const res = await fetch('/media', {
    method: 'POST',
    headers: { 'Content-Type': f.type, Authorization: `Bearer ${state.hub.token}`, 'X-Name': encodeURIComponent(f.file.name || 'pasted.png') },
    body: f.file,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `upload failed (${res.status})`);
  }
  return res.json();
};
const uploadAll = async () => {
  if (files.length === 0) return undefined;
  const out = [];
  for (const f of files) out.push(await upload(f));
  return out;
};
$('fileInput').addEventListener('change', (e) => {
  for (const f of e.target.files) addFile(f);
  e.target.value = '';
});
$('text').addEventListener('paste', (e) => {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])].filter((it) => it.kind === 'file');
  if (items.length === 0) return;
  e.preventDefault();
  for (const it of items) addFile(it.getAsFile());
});
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  for (const f of e.dataTransfer.files) addFile(f);
});

// MARK: calls. The hub relays raw audio between everyone in a room's call: PCM16 mono at 16 kHz,
// 40 ms to a frame, base64 — the same frames the terminal chat pipes through sox. The browser
// records with its own echo cancellation, sends only while the voice is up, and plays each
// speaker on their own schedule so the voices mix in the audio graph.
const VOICE_RATE = 16000;
const FRAME = (VOICE_RATE * 40) / 1000;
// Voice detection and levelling, the same numbers as the terminal (cli/lib/voice.js): the gate
// sits a margin over the room's noise floor (the quietest frame of the last 3 s), keeps 200 ms
// from before the voice and 600 ms after it, and what passes is levelled toward -18 dBFS.
const SHAPE = { minGate: 120, overFloor: 2.5, preroll: 5, hangover: 15, target: 4000, maxGain: 8, window: 75 };
const call = { room: null, mic: false, speaking: false, ctx: null, stream: null, node: null, pending: [], next: new Map(), roster: [], shape: null };

const newShape = () => ({ levels: [], gain: 1, open: 0, held: [] });

const levelled = (frame, gain) => {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const x = (frame[i] * gain) / 32768;
    const a = Math.abs(x);
    const y = a < 0.5 ? x : Math.sign(x) * (0.5 + 0.5 * Math.tanh((a - 0.5) / 0.5));
    out[i] = Math.round(Math.max(-1, Math.min(1, y)) * 32767);
  }
  return out;
};

/// One frame in; the frames to send out (none, this one, or the pre-roll and this one).
const shapeFrame = (s, frame) => {
  let e = 0;
  for (const v of frame) e += v * v;
  const level = Math.sqrt(e / frame.length);
  s.levels.push(level);
  if (s.levels.length > SHAPE.window) s.levels.shift();
  const floor = Math.max(10, Math.min(...s.levels));
  const loud = level >= Math.max(SHAPE.minGate, floor * SHAPE.overFloor);
  if (loud) {
    const want = Math.min(SHAPE.maxGain, Math.max(1, SHAPE.target / level));
    s.gain = want < s.gain ? want : s.gain + (want - s.gain) * 0.15;
  }
  const wasOpen = s.open > 0;
  if (loud) s.open = SHAPE.hangover + 1;
  else if (s.open) s.open--;
  const out = s.open > 0 ? (wasOpen ? [frame] : [...s.held, frame]) : [];
  s.held = s.open > 0 ? [] : [...s.held, frame].slice(-SHAPE.preroll);
  return { speaking: s.open > 0, frames: out.map((f) => levelled(f, s.gain)) };
};

const toBase64 = (int16) => {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const fromBase64 = (b64) => {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
};

const sendFrame = (frame) => {
  if (state.hub) state.hub.call('voice/frame', { data: toBase64(frame) }).catch(() => {});
};

// Float samples at the context's rate, averaged down to 16 kHz int16, cut into 40 ms frames,
// shaped (gate and level) and sent while the voice is up — silence costs nothing.
const captured = (input) => {
  if (!call.shape) call.shape = newShape();
  const ratio = call.ctx.sampleRate / VOICE_RATE;
  for (let pos = 0; pos + ratio <= input.length; pos += ratio) {
    let sum = 0;
    let n = 0;
    for (let j = Math.floor(pos); j < Math.floor(pos + ratio); j++, n++) sum += input[j];
    call.pending.push(Math.max(-1, Math.min(1, n ? sum / n : input[Math.floor(pos)])) * 32767);
  }
  while (call.pending.length >= FRAME) {
    const frame = Int16Array.from(call.pending.splice(0, FRAME));
    const { speaking, frames } = shapeFrame(call.shape, frame);
    for (const f of frames) sendFrame(f);
    if (speaking !== call.speaking) {
      call.speaking = speaking;
      renderCall();
    }
  }
};

// How unevenly each speaker's audio arrives: a connection that stalls and then delivers a second
// at once needs that much in hand, a steady one 80 ms. A stall shows in the lump after it; the
// few frames of pre-roll after a pause in the talk (up to 240 ms) do not count. The largest lump
// in the last 10 s, within 80 ms .. 1.2 s — the same rule as the terminal (cli/lib/voice.js).
const jitter = new Map();
const bufferFor = (from) => {
  const j = jitter.get(from);
  if (!j || !j.lumps.length) return 0.08;
  return Math.min(1.2, Math.max(0.08, Math.max(...j.lumps.map((l) => l.late)) / 1000));
};

const heard = ({ room, from, data }) => {
  if (!call.ctx || room !== call.room) return;
  const t = performance.now();
  const j = jitter.get(from) || { lumps: [], last: 0, run: 0, runGap: 0 };
  const secs = (data.length * 3) / 4 / 2 / VOICE_RATE;
  if (t - j.last < 10) j.run += secs;
  else {
    j.run = secs;
    j.runGap = (t - j.last) / 1000;
  }
  if (j.run - secs > 0.24) j.lumps.push({ at: t, late: Math.min(j.runGap, j.run - secs) * 1000 });
  j.lumps = j.lumps.filter((l) => t - l.at < 10000);
  j.last = t;
  jitter.set(from, j);
  const target = bufferFor(from);
  const now = call.ctx.currentTime;
  let at = call.next.get(from) || 0;
  // far more queued than this speaker's jitter needs (it is really ahead): drop frames until
  // it is back, rather than keep the whole call that far behind
  if (at > now + Math.max(0.25, 2 * target + 0.3)) return; // a buffer, a lump on top, and slack
  // ran dry: start again one buffer out
  if (at < now + 0.01) at = now + target;
  const pcm = fromBase64(data);
  const buf = call.ctx.createBuffer(1, pcm.length, VOICE_RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = call.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(call.ctx.destination);
  src.start(at);
  call.next.set(from, at + buf.duration);
};

const startMic = async () => {
  if (call.stream) return true;
  try {
    call.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (error) {
    toast(`mic: ${error.message || error.name}`);
    return false;
  }
  const source = call.ctx.createMediaStreamSource(call.stream);
  // ScriptProcessor, not a worklet: a worklet is one more file under the CSP. 2048 samples is
  // ~43 ms at 48 kHz: small enough not to add delay, large enough not to stutter on a phone
  const node = call.ctx.createScriptProcessor(2048, 1, 1);
  node.onaudioprocess = (e) => {
    if (call.mic) captured(e.inputBuffer.getChannelData(0));
  };
  source.connect(node);
  node.connect(call.ctx.destination); // it only runs while connected; it writes silence
  call.node = node;
  return true;
};

const stopMic = () => {
  if (call.node) call.node.disconnect();
  call.node = null;
  if (call.stream) for (const t of call.stream.getTracks()) t.stop();
  call.stream = null;
  call.pending = [];
  call.shape = null;
  call.speaking = false;
};

const joinCall = async () => {
  if (!state.room) return;
  // the audio context has to be made in the tap, or iOS keeps it silent
  call.ctx = call.ctx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  await call.ctx.resume().catch(() => {});
  const mic = await startMic();
  call.room = state.room;
  call.mic = mic;
  const s = await state.hub.call('voice/join', { room: state.room, mic });
  onVoice(s);
  if (!mic) toast('listening only: the mic is not allowed');
};

const leaveCall = async () => {
  if (!call.room) return;
  stopMic();
  call.room = null;
  call.mic = false;
  call.next.clear();
  renderCall();
  await state.hub.call('voice/leave', {}).catch(() => {});
};

const toggleMic = async () => {
  if (!call.room) return;
  const on = !call.mic;
  if (on && !(await startMic())) return;
  if (!on) stopMic();
  call.mic = on;
  renderCall();
  await state.hub.call('voice/mic', { on }).catch((e) => toast(e.message));
};

const onVoice = ({ room, participants }) => {
  if (room !== state.room) return;
  call.roster = participants;
  renderCall();
};

const renderCall = () => {
  const box = $('call');
  box.replaceChildren();
  $('voice').textContent = call.room ? 'leave' : 'voice';
  $('voice').classList.toggle('on', Boolean(call.room));
  const me = state.me && state.me.name;
  for (const p of call.roster) {
    const mine = call.room && p.name === me;
    const mic = mine ? call.mic : p.mic;
    const speaking = mine ? call.mic && call.speaking : p.speaking;
    const chip = el('div', `caller${mine ? ' me' : ''}${mic ? '' : ' muted'}${speaking ? ' speaking' : ''}`);
    const bars = el('span', 'bars');
    bars.append(el('i'), el('i'), el('i'));
    chip.append(bars, el('span', 'who', p.name));
    if (mine) {
      chip.title = call.mic ? 'tap to mute' : 'tap to unmute';
      chip.onclick = () => toggleMic();
    }
    box.append(chip);
  }
};

$('voice').onclick = () => (call.room ? leaveCall() : joinCall()).catch((e) => toast(e.message));

const loadRoom = async (room) => {
  if (call.room && call.room !== room) await leaveCall();
  state.room = room;
  call.roster = [];
  renderCall();
  if (state.hub) {
    const calls = await state.hub.call('voice/calls', {}).catch(() => []);
    const here = calls.find((c) => c.room === room);
    if (here) onVoice(here);
  }
  store.set('hub.room', room);
  $('stream').replaceChildren(el('div', 'empty', 'no messages'));
  scroll.pinned = true;
  scroll.seen();
  const history = await withBusy(() => state.hub.call('room/history', { room, limit: 100 }));
  for (const m of history) renderMessage(m);
  scroll.settle();
  renderAgents();
};

const start = async (token) => {
  const hub = new Hub(wsUrl(), token);
  state.hub = hub;
  hub.onState = (on) => {
    // the label for the room picker while connected; "offline" is the one state worth a word
    $('state').textContent = on ? 'room' : 'offline';
    $('state').classList.toggle('on', on);
    $('headLogo').classList.toggle('spin', !on);
    // a reconnect is a new connection: the hub no longer has it in the call
    if (on && call.room) hub.call('voice/join', { room: call.room, mic: call.mic }).then(onVoice).catch(() => {});
  };
  hub.on('voice/changed', onVoice);
  hub.on('voice/frame', heard);
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

// iOS Safari does not shrink the layout viewport for the on-screen keyboard; it shrinks the
// visual viewport and scrolls it to reveal the focused field, which pushes a fixed-height page
// off screen. Size the body to the visual viewport and shift it by the viewport's offset so the
// header, stream and composer stay on screen above the keyboard.
const vv = window.visualViewport;
const viewportHeight = () => (vv ? vv.height : window.innerHeight);
const fitViewport = () => {
  if (!vv) return;
  const root = document.documentElement.style;
  root.setProperty('--vh', Math.round(vv.height) + 'px');
  root.setProperty('--vv-top', Math.round(vv.offsetTop) + 'px');
  document.body.classList.toggle('keyboard', window.innerHeight - vv.height > 120);
  if (scroll.pinned) scroll.toBottom();
};
if (vv) {
  vv.addEventListener('resize', fitViewport);
  vv.addEventListener('scroll', fitViewport);
  fitViewport();
}
// Some iOS versions still nudge the document itself; keep it at the top so nothing hides.
window.addEventListener('scroll', () => {
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
});

const autosize = () => {
  const t = $('text');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, viewportHeight() * 0.4) + 'px';
};
$('text').addEventListener('input', () => {
  autosize();
  onTextChange();
});
for (const ev of ['focus', 'click', 'keyup']) $('text').addEventListener(ev, renderMention);
$('text').addEventListener('blur', () => $('mention').classList.add('hidden'));

$('composer').onsubmit = async (event) => {
  event.preventDefault();
  const raw = $('text').value.trim();
  const target = leadingMention(raw);
  const agent = state.members.find((m) => m.kind === 'agent' && m.name === target);
  // the mention comes off for a known agent or the room; "auto" keeps it, the router reads names
  const text = agent || target === 'room' ? raw.replace(MENTION, '').trim() : raw;
  if (!text && files.length === 0) return;
  const button = $('send');
  button.disabled = true;
  try {
    await withBusy(async () => {
      const media = await uploadAll();
      if (target === 'room') await state.hub.call('room/say', { room: state.room, text, media });
      else if (agent) await state.hub.call('agents/send', { to: agent.name, text, kind: 'command', media });
      else await state.hub.call('agents/dispatch', { text, room: state.room, media });
    });
    $('text').value = agent ? `@${agent.name} ` : '';
    clearFiles();
    autosize();
    onTextChange();
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
