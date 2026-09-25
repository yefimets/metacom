'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

/// Room calls from a terminal. The hub relays raw audio: PCM, signed 16-bit little-endian,
/// mono, 16 kHz, 40 ms to a frame, base64. Node has no microphone or speaker of its own, so
/// a recorder and a player the machine already has do that part (sox on a Mac: brew install
/// sox), and this file cuts, gates, levels and mixes the bytes in between.
const RATE = 16_000;
const FRAME_MS = 40;
const FRAME_BYTES = (RATE * 2 * FRAME_MS) / 1000;
const TICK_MS = 20;
const ms = (n) => Math.round((RATE * 2 * n) / 1000 / 2) * 2; // bytes of n milliseconds
// A speaker gathers this much before playing (network jitter); past MAX_LAG the oldest audio
// goes, so a burst after a stall does not leave the call running behind for good.
const PREBUFFER = ms(80);
const MAX_LAG = ms(250);
const KEEP_LAG = ms(120);

/// Voice detection and levelling, the same numbers as the phone (hub/web/app.js).
const SHAPE = {
  minGate: Number(process.env.MC_VOICE_GATE) || 120, // RMS on the int16 scale, the floor for the gate
  overFloor: 2.5, // the gate opens this far above the room's noise
  preroll: 5, // frames kept from before the voice, so the first syllable lands (200 ms)
  hangover: 15, // frames kept open after it drops, so words and pauses are not clipped (600 ms)
  target: 4000, // RMS of speech after levelling, about -18 dBFS
  maxGain: 8,
};

const RAW = ['-t', 'raw', '-r', String(RATE), '-e', 'signed', '-b', '16', '-c', '1'];
// sox reads and writes 8 KB at a time by default: 256 ms of this audio, each way
const SOX_BUFFER = ['--buffer', String(FRAME_BYTES)];

/// Recorder and player candidates, best first. Each writes or reads the wire format on
/// stdin/stdout. MC_VOICE_REC / MC_VOICE_PLAY take a shell command that does the same.
const CANDIDATES = {
  rec: [
    ['rec', ['-q', ...SOX_BUFFER, ...RAW, '-']],
    ['sox', ['-q', ...SOX_BUFFER, '-d', ...RAW, '-']],
    ['pw-record', ['--latency', '40ms', '--rate', String(RATE), '--channels', '1', '--format', 's16', '-']],
    ['parec', ['--rate', String(RATE), '--channels', '1', '--format', 's16le', '--latency-msec', '30']],
    ['arecord', ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw', '--buffer-time', '80000']],
    ['ffmpeg', process.platform === 'darwin'
      ? ['-loglevel', 'quiet', '-fflags', 'nobuffer', '-f', 'avfoundation', '-i', ':default', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-']
      : ['-loglevel', 'quiet', '-fflags', 'nobuffer', '-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-']],
  ],
  play: [
    ['play', ['-q', ...SOX_BUFFER, ...RAW, '-']],
    ['sox', ['-q', ...SOX_BUFFER, ...RAW, '-', '-d']],
    ['pw-play', ['--latency', '40ms', '--rate', String(RATE), '--channels', '1', '--format', 's16', '-']],
    ['pacat', ['--playback', '--rate', String(RATE), '--channels', '1', '--format', 's16le', '--latency-msec', '40']],
    ['aplay', ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw', '--buffer-time', '80000']],
    ['ffplay', ['-loglevel', 'quiet', '-nodisp', '-fflags', 'nobuffer', '-f', 's16le', '-ar', String(RATE), '-ch_layout', 'mono', '-']],
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

/// Decides which mic frames go out and how loud. The gate follows the room: it opens a margin
/// above the noise floor it has measured, never below `minGate`, so a quiet mic in a quiet room
/// still gets through and a fan does not hold it open. What passes is levelled toward `target`
/// with a gain that rises slowly and falls at once, then soft-limited so it never clips.
class Shaper {
  constructor(opts = {}) {
    this.o = { ...SHAPE, ...opts };
    this.floor = this.o.minGate / this.o.overFloor;
    this.gain = 1;
    this.open = 0;
    this.held = []; // pre-roll
    this.levels = []; // the last 3 s, for the noise floor
  }

  get threshold() {
    return Math.max(this.o.minGate, this.floor * this.o.overFloor);
  }

  /// One frame in, the frames to send out (none, this one, or the pre-roll and this one).
  push(frame) {
    const level = rms(frame);
    // the noise floor is the quietest frame of the last 3 s: speech always has gaps between
    // words, steady noise has none, so the floor finds the room either way
    this.levels = [...this.levels, level].slice(-75);
    this.floor = Math.max(10, Math.min(...this.levels));
    const loud = level >= this.threshold;
    if (loud) {
      const want = Math.min(this.o.maxGain, Math.max(1, this.o.target / level));
      this.gain = want < this.gain ? want : this.gain + (want - this.gain) * 0.15;
    }
    const wasOpen = this.open > 0;
    if (loud) this.open = this.o.hangover + 1;
    else if (this.open) this.open--;
    let out = [];
    if (this.open > 0) out = wasOpen ? [frame] : [...this.held, frame];
    this.held = this.open > 0 ? [] : [...this.held, frame].slice(-this.o.preroll);
    return { speaking: this.open > 0, frames: out.map((f) => this.level(f)) };
  }

  level(frame) {
    const out = Buffer.alloc(frame.length);
    for (let i = 0; i + 1 < frame.length; i += 2) {
      const x = (frame.readInt16LE(i) * this.gain) / 32768;
      // soft knee above ~-6 dBFS: tanh keeps peaks round instead of clipping them flat
      const y = Math.abs(x) < 0.5 ? x : Math.sign(x) * (0.5 + 0.5 * Math.tanh((Math.abs(x) - 0.5) / 0.5));
      out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, y)) * 32767), i);
    }
    return out;
  }
}

/// One terminal's part in a call: the mic (recorder -> frames -> `send`) and the speaker
/// (frames from the hub -> per-speaker queues -> one mixed stream -> player).
/// Events: 'speaking' (bool, this mic), 'error' (message; the call goes on without that half).
class Audio extends EventEmitter {
  constructor({ send, tools: picked = tools(), spawner = spawn, shape = {} } = {}) {
    super();
    this.send = send;
    this.tools = picked;
    this.spawner = spawner;
    this.shape = shape;
    this.shaper = new Shaper(shape);
    this.recorder = null;
    this.player = null;
    this.pending = Buffer.alloc(0);
    this.speaking = false;
    this.queues = new Map(); // speaker -> { buf, playing, last }
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
    this.shaper = new Shaper(this.shape);
    this.setSpeaking(false);
  }

  captured(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= FRAME_BYTES) {
      const frame = Buffer.from(this.pending.subarray(0, FRAME_BYTES));
      this.pending = this.pending.subarray(FRAME_BYTES);
      const { speaking, frames } = this.shaper.push(frame);
      for (const f of frames) this.send(f.toString('base64'));
      this.setSpeaking(speaking);
    }
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
    // behind by more than MAX_LAG (a stall, then a burst): drop the oldest, back to KEEP_LAG
    if (q.buf.length > MAX_LAG) q.buf = q.buf.subarray(q.buf.length - KEEP_LAG);
    q.last = Date.now();
    this.queues.set(from, q);
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /// Feed the player what wall time says is due since it started, so a late timer catches up
  /// instead of letting the delay grow. Nothing to play: stop the clock, let the player drain.
  tick(now = Date.now()) {
    // a speaker starts once it has enough buffered, or once nothing more is coming
    const live = [...this.queues.entries()].filter(([, q]) => q.playing || q.buf.length >= PREBUFFER || now - q.last > 100);
    if (!live.length) {
      this.clock = null;
      if (![...this.queues.values()].some((q) => q.buf.length)) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return null;
    }
    if (!this.clock) this.clock = { t0: now, written: 0 };
    const due = Math.floor(((now - this.clock.t0) * RATE) / 1000) * 2 - this.clock.written + ms(TICK_MS);
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

module.exports = { Audio, Shaper, tools, rms, mix, RATE, FRAME_BYTES, FRAME_MS };
