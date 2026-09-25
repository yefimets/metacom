'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

/// Room calls from a terminal. The hub relays raw audio: PCM, signed 16-bit little-endian,
/// mono, 16 kHz, 100 ms to a frame, base64. Node has no microphone or speaker of its own, so
/// a recorder and a player the machine already has do that part (sox on a Mac: brew install
/// sox), and this file cuts, gates and mixes the bytes in between.
const RATE = 16_000;
const FRAME_BYTES = (RATE * 2) / 10; // 100 ms
const TICK_MS = 20;
const PREBUFFER = (RATE * 2 * 120) / 1000; // bytes a speaker gathers before playing: jitter
const MAX_QUEUE = RATE * 2; // one second per speaker at most; older audio is dropped
const HANGOVER = 4; // frames kept open after the voice drops, so words are not clipped
const GATE = Number(process.env.MC_VOICE_GATE) || 600; // RMS on the int16 scale, ~-35 dBFS

const RAW = ['-t', 'raw', '-r', String(RATE), '-e', 'signed', '-b', '16', '-c', '1'];

/// Recorder and player candidates, best first. Each writes or reads the wire format on
/// stdin/stdout. MC_VOICE_REC / MC_VOICE_PLAY take a shell command that does the same.
const CANDIDATES = {
  rec: [
    ['rec', ['-q', ...RAW, '-']],
    ['sox', ['-q', '-d', ...RAW, '-']],
    ['pw-record', ['--rate', String(RATE), '--channels', '1', '--format', 's16', '-']],
    ['parec', ['--rate', String(RATE), '--channels', '1', '--format', 's16le', '--latency-msec', '50']],
    ['arecord', ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw']],
    ['ffmpeg', process.platform === 'darwin'
      ? ['-loglevel', 'quiet', '-f', 'avfoundation', '-i', ':default', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-']
      : ['-loglevel', 'quiet', '-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-']],
  ],
  play: [
    ['play', ['-q', ...RAW, '-']],
    ['sox', ['-q', ...RAW, '-', '-d']],
    ['pw-play', ['--rate', String(RATE), '--channels', '1', '--format', 's16', '-']],
    ['pacat', ['--playback', '--rate', String(RATE), '--channels', '1', '--format', 's16le', '--latency-msec', '80']],
    ['aplay', ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw']],
    ['ffplay', ['-loglevel', 'quiet', '-nodisp', '-f', 's16le', '-ar', String(RATE), '-ch_layout', 'mono', '-']],
  ],
};

const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;

/// What will record and what will play here, or why nothing can.
const tools = (env = process.env, exists = has) => {
  const pick = (kind, override) => {
    if (env[override]) return ['sh', ['-c', env[override]]];
    return CANDIDATES[kind].find(([cmd]) => exists(cmd)) || null;
  };
  const rec = pick('rec', 'MC_VOICE_REC');
  const play = pick('play', 'MC_VOICE_PLAY');
  const hint = process.platform === 'darwin' ? 'brew install sox' : 'apt install sox (or pulseaudio-utils, alsa-utils)';
  return { rec, play, hint };
};

/// Loudness of a frame of int16 samples, root mean square.
const rms = (buf) => {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
};

/// Sum of the speakers' next chunks, clipped to int16.
const mix = (chunks, bytes) => {
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) {
    let s = 0;
    for (const c of chunks) if (i + 1 < c.length) s += c.readInt16LE(i);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i);
  }
  return out;
};

/// One terminal's part in a call: the mic (recorder -> frames -> `send`) and the speaker
/// (frames from the hub -> per-speaker queues -> one mixed stream -> player).
/// Events: 'speaking' (bool, this mic), 'error' (message; the call goes on without that half).
class Audio extends EventEmitter {
  constructor({ send, tools: picked = tools(), spawner = spawn, gate = GATE } = {}) {
    super();
    this.send = send;
    this.tools = picked;
    this.spawner = spawner;
    this.gate = gate;
    this.recorder = null;
    this.player = null;
    this.pending = Buffer.alloc(0);
    this.open = 0; // frames left before the gate closes
    this.previous = null; // the frame before speech, sent with it so the first syllable lands
    this.speaking = false;
    this.queues = new Map(); // speaker -> { buf, playing }
    this.timer = null;
    this.clock = null; // { t0, written } while the player is fed
  }

  // MARK: mic

  startMic() {
    if (this.recorder) return true;
    if (!this.tools.rec) {
      this.emit('error', `no recorder for the mic · ${this.tools.hint}`);
      return false;
    }
    const [cmd, args] = this.tools.rec;
    const child = this.spawner(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.recorder = child;
    child.on('error', (e) => this.lost('recorder', child, e.message));
    child.on('exit', (code) => this.lost('recorder', child, `${cmd} exited${code ? ' with ' + code : ''}`));
    child.stdout.on('data', (chunk) => this.captured(chunk));
    return true;
  }

  stopMic() {
    const child = this.recorder;
    this.recorder = null;
    if (child) child.kill();
    this.pending = Buffer.alloc(0);
    this.open = 0;
    this.previous = null;
    this.setSpeaking(false);
  }

  captured(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= FRAME_BYTES) {
      const frame = this.pending.subarray(0, FRAME_BYTES);
      this.pending = this.pending.subarray(FRAME_BYTES);
      this.gateFrame(Buffer.from(frame));
    }
  }

  /// Send only while the voice is up (plus a little after), so a quiet room costs nothing
  /// and the hub can tell who is talking from who is sending.
  gateFrame(frame) {
    const loud = rms(frame) >= this.gate;
    if (loud) {
      if (!this.open && this.previous) this.send(this.previous.toString('base64'));
      this.open = HANGOVER + 1; // this frame, then HANGOVER quiet ones
    } else if (this.open) {
      this.open--;
    }
    this.previous = frame;
    this.setSpeaking(this.open > 0);
    if (this.open > 0) this.send(frame.toString('base64'));
  }

  setSpeaking(on) {
    if (this.speaking === on) return;
    this.speaking = on;
    this.emit('speaking', on);
  }

  // MARK: speaker

  /// A frame someone else said.
  play(from, data) {
    const bytes = Buffer.from(String(data || ''), 'base64');
    if (!bytes.length) return;
    const q = this.queues.get(from) || { buf: Buffer.alloc(0), playing: false, last: 0 };
    q.buf = Buffer.concat([q.buf, bytes]);
    q.last = Date.now();
    if (q.buf.length > MAX_QUEUE) q.buf = q.buf.subarray(q.buf.length - MAX_QUEUE);
    this.queues.set(from, q);
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /// Feed the player what wall time says is due since it started, so a late timer catches up
  /// instead of letting the delay grow. Nothing to play: stop the clock, let the player drain.
  tick(now = Date.now()) {
    // a speaker starts once it has enough buffered, or once nothing more is coming
    const live = [...this.queues.entries()].filter(([, q]) => q.playing || q.buf.length >= PREBUFFER || now - q.last > 150);
    if (!live.length) {
      this.clock = null;
      if (![...this.queues.values()].some((q) => q.buf.length)) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return null;
    }
    if (!this.clock) this.clock = { t0: now, written: 0 };
    const due = Math.floor(((now - this.clock.t0) * RATE) / 1000) * 2 - this.clock.written + TICK_MS * (RATE / 1000) * 2;
    if (due <= 0) return null;
    const chunks = [];
    for (const [name, q] of live) {
      q.playing = true;
      chunks.push(q.buf.subarray(0, due));
      q.buf = q.buf.subarray(Math.min(due, q.buf.length));
      if (!q.buf.length) {
        q.playing = false;
        this.queues.delete(name);
      }
    }
    const out = mix(chunks, due);
    this.clock.written += due;
    this.write(out);
    return out;
  }

  write(buf) {
    if (!this.player) {
      if (!this.tools.play) {
        if (!this.warnedPlay) this.emit('error', `no player for the speaker · ${this.tools.hint}`);
        this.warnedPlay = true;
        return;
      }
      const [cmd, args] = this.tools.play;
      const child = this.spawner(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      this.player = child;
      child.on('error', (e) => this.lost('player', child, e.message));
      child.on('exit', (code) => this.lost('player', child, `${cmd} exited${code ? ' with ' + code : ''}`));
      child.stdin.on('error', () => {});
    }
    this.player.stdin.write(buf);
  }

  lost(which, child, why) {
    if (which === 'recorder' && this.recorder === child) {
      this.recorder = null;
      this.setSpeaking(false);
      this.emit('error', `mic stopped: ${why}`);
    }
    if (which === 'player' && this.player === child) {
      this.player = null;
      this.emit('error', `speaker stopped: ${why}`);
    }
  }

  close() {
    this.stopMic();
    clearInterval(this.timer);
    this.timer = null;
    this.queues.clear();
    this.clock = null;
    const p = this.player;
    this.player = null;
    if (p) {
      p.stdin.end();
      p.kill();
    }
  }
}

module.exports = { Audio, tools, rms, mix, RATE, FRAME_BYTES };
