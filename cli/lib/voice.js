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
// Some recorders hand their audio over in lumps (a second at a time), so a speaker's queue can
// be long for a moment and then run dry: that is jitter, and it is played through. Only a queue
// that stays longer than STANDING_LAG for a whole LAG_WINDOW (the speaker is really ahead of
// real time) is cut back to KEEP_LAG; HARD_LAG bounds it no matter what.
const STANDING_LAG = ms(300);
const LAG_WINDOW = 2000;
const KEEP_LAG = ms(150);
const HARD_LAG = ms(2000);
// After the last voice, the player is fed silence this long: sox plays nothing until its buffer
// (8 KB, 256 ms, where a smaller one is refused) is full, so without it the end of a sentence
// would wait inside sox until someone spoke again.
const FLUSH_MS = 1000;

/// Sample rates a recorder may use when it ignores the one it was asked for.
const RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000];

/// Linear resampling of int16 mono from `from` Hz to RATE, carrying the fraction and the
/// unconsumed input between chunks in `state`.
const resample = (state, chunk, from) => {
  const input = Buffer.concat([state.rest || Buffer.alloc(0), chunk]);
  const n = Math.floor(input.length / 2);
  const step = from / RATE;
  const out = [];
  let pos = state.pos || 0;
  while (pos + 1 < n) {
    const i = Math.floor(pos);
    const f = pos - i;
    out.push(Math.round(input.readInt16LE(i * 2) * (1 - f) + input.readInt16LE(i * 2 + 2) * f));
    pos += step;
  }
  const used = Math.min(Math.floor(pos), n);
  state.rest = input.subarray(used * 2);
  state.pos = pos - used;
  const buf = Buffer.alloc(out.length * 2);
  out.forEach((v, k) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), k * 2));
  return buf;
};

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

const sh = (cmd, args) => [cmd, ...args].map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');

/// Every way to run the recorder or the player here, best first: each tool found, sox asked for
/// small buffers first (less delay), then a larger one, then its own default, then the same
/// behind `cat` — node hands a child a socket, not a pipe, and a player that will not read a
/// socket gets a real pipe that way. The next tool only when all of those failed.
const variants = (which, candidates) => {
  const out = [];
  for (const [cmd, args] of candidates) {
    const at = args.indexOf('--buffer');
    const sizes = at < 0 ? [args] : [args, [...args.slice(0, at), '--buffer', '4096', ...args.slice(at + 2)], [...args.slice(0, at), ...args.slice(at + 2)]];
    for (const a of sizes) out.push([cmd, a]);
    if (cmd === 'sh') continue;
    const plain = sizes.at(-1);
    out.push(['sh', ['-c', which === 'player' ? `cat | exec ${sh(cmd, plain)}` : `${sh(cmd, plain)} | cat`]]);
  }
  return out;
};
// a tool that exits this soon after it started did not work, rather than stopped
const QUICK_EXIT_MS = 1500;

// MARK: devices

/// The audio devices here, for /devices, /input and /output: { inputs, outputs } of
/// { name, label, default }, or { error } where there is no way to ask. A Mac answers through
/// system_profiler, Linux through PulseAudio or PipeWire (pactl).
const listDevices = (run = spawnSync, platform = process.platform) => {
  if (platform === 'darwin') {
    const r = run('system_profiler', ['SPAudioDataType', '-json'], { encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0 || !r.stdout) return { error: 'system_profiler did not answer' };
    let items = [];
    try {
      items = (JSON.parse(r.stdout).SPAudioDataType || []).flatMap((x) => x._items || []);
    } catch {
      return { error: 'system_profiler gave something unreadable' };
    }
    const pick = (flag, def) => items.filter((d) => d[flag]).map((d) => ({ name: d._name, label: d._name, default: d[def] === 'spaudio_yes' }));
    return { inputs: pick('coreaudio_device_input', 'coreaudio_default_audio_input_device'), outputs: pick('coreaudio_device_output', 'coreaudio_default_audio_output_device') };
  }
  const list = (kind) => {
    const r = run('pactl', ['list', kind], { encoding: 'utf8', timeout: 5_000 });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout
      .split(/\n(?=\S)/)
      .map((block) => ({ name: (block.match(/^\s*Name: (.+)$/m) || [])[1], label: (block.match(/^\s*Description: (.+)$/m) || [])[1] }))
      .filter((d) => d.name && !d.name.endsWith('.monitor'))
      .map((d) => ({ name: d.name, label: d.label || d.name, default: false }));
  };
  const inputs = list('sources');
  const outputs = list('sinks');
  if (!inputs || !outputs) return { error: 'no pactl here to list devices; /input and /output still take a device name' };
  const info = run('pactl', ['info'], { encoding: 'utf8', timeout: 5_000 }).stdout || '';
  const def = (what) => (info.match(new RegExp(`^Default ${what}: (.+)$`, 'm')) || [])[1];
  for (const d of inputs) d.default = d.name === def('Source');
  for (const d of outputs) d.default = d.name === def('Sink');
  return { inputs, outputs };
};

/// What the user typed after /input or /output, as a device name: a number from /devices, a
/// piece of a name, or "default" for the system's own choice (null).
const resolveDevice = (arg, list) => {
  const a = String(arg || '').trim();
  if (!a || /^(default|system|auto)$/i.test(a)) return { name: null };
  if (!list) return { name: a };
  if (/^\d+$/.test(a)) {
    const d = list[Number(a) - 1];
    return d ? { name: d.name } : { error: `no device ${a} · /devices lists them` };
  }
  const exact = list.find((d) => d.name.toLowerCase() === a.toLowerCase() || d.label.toLowerCase() === a.toLowerCase());
  if (exact) return { name: exact.name };
  const found = list.filter((d) => `${d.name} ${d.label}`.toLowerCase().includes(a.toLowerCase()));
  if (found.length === 1) return { name: found[0].name };
  return { error: found.length ? `"${a}" matches ${found.map((d) => d.label).join(', ')} · say more` : `no device like "${a}" · /devices lists them` };
};

/// The command, its arguments and environment with a device chosen. sox (and a shell around
/// it) reads AUDIODEV; the others take a flag.
const withDevice = (cmd, args, device, platform = process.platform) => {
  if (!device) return { args, env: {} };
  const env = { AUDIODEV: device };
  if (platform !== 'darwin' && ['rec', 'play', 'sox', 'sh'].includes(cmd)) env.AUDIODRIVER = 'pulseaudio';
  if (cmd === 'pw-record' || cmd === 'pw-play') return { args: ['--target', device, ...args], env };
  if (cmd === 'parec' || cmd === 'pacat') return { args: [`--device=${device}`, ...args], env };
  if (cmd === 'arecord' || cmd === 'aplay') return { args: ['-D', device, ...args], env };
  if (cmd === 'ffmpeg') return { args: args.map((a) => (a === ':default' ? `:${device}` : a === 'default' ? device : a)), env };
  return { args, env };
};

/// The chosen devices, kept apart from the hub config so choosing one never rewrites a token.
const prefsFile = () => require('node:path').join(require('node:os').homedir(), '.config', 'metacom-hub', 'voice.json');
const loadPrefs = (file = prefsFile()) => {
  try {
    const p = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    return { input: p.input || null, output: p.output || null };
  } catch {
    return { input: null, output: null };
  }
};
const savePrefs = (prefs, file = prefsFile()) => {
  const fs = require('node:fs');
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ input: prefs.input || null, output: prefs.output || null }, null, 2) + '\n', { mode: 0o600 });
};

const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;

/// What will record and what will play here, or why nothing can.
const tools = (env = process.env, exists = has) => {
  const all = (kind, override) => (env[override] ? [['sh', ['-c', env[override]]]] : CANDIDATES[kind].filter(([cmd]) => exists(cmd)));
  const recs = all('rec', 'MC_VOICE_REC');
  const plays = all('play', 'MC_VOICE_PLAY');
  const hint = process.platform === 'darwin' ? 'brew install sox' : 'apt install sox (or pulseaudio-utils, alsa-utils)';
  return { rec: recs[0] || null, play: plays[0] || null, recs, plays, hint };
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
  constructor({ send, tools: picked = tools(), spawner = spawn, shape = {}, devices = {} } = {}) {
    super();
    this.devices = { input: devices.input || null, output: devices.output || null };
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
    this.lastVoice = 0;
    this.inRate = RATE; // what the recorder really gives, once measured
    this.rs = {}; // resampler state
    this.cap = { t0: 0, bytes: 0, maxChunk: 0, decided: false, hz: 0 };
    this.stats = { frames: 0, bytes: 0, dropped: 0, gaps: 0, sent: 0, run: 0, burst: 0, activeMs: 0, activeBytes: 0 };
    this.variant = { recorder: 0, player: 0 }; // which of variants() works here
    this.broken = { recorder: false, player: false }; // every variant failed: stop trying
    this.wantMic = false;
  }

  // MARK: mic

  startMic() {
    this.wantMic = true;
    if (this.recorder) return true;
    if (!this.tools.rec) {
      this.emit('error', `no recorder for the mic · ${this.tools.hint}`);
      return false;
    }
    if (this.broken.recorder) return false;
    const child = this.launch('recorder');
    child.stdout.on('data', (chunk) => this.captured(chunk));
    return true;
  }

  /// Start the recorder or the player with its current variant, keeping the end of what it
  /// says on stderr so a failure can be told in its own words.
  launch(which) {
    const list = variants(which, which === 'recorder' ? this.tools.recs || [this.tools.rec] : this.tools.plays || [this.tools.play]);
    const [cmd, plain] = list[Math.min(this.variant[which], list.length - 1)];
    const { args, env } = withDevice(cmd, plain, which === 'recorder' ? this.devices.input : this.devices.output);
    const child = this.spawner(cmd, args, {
      stdio: which === 'recorder' ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, ...env },
    });
    child.startedAt = Date.now();
    child.said = '';
    child.variants = list.length;
    if (child.stderr) child.stderr.on('data', (d) => (child.said = (child.said + d).slice(-300)));
    this[which] = child;
    const name = cmd === 'sh' ? String(args[1]).replace(/'/g, '').slice(0, 60) : cmd;
    child.on('error', (e) => this.lost(which, child, e.message, name));
    child.on('exit', (code, signal) => this.lost(which, child, signal ? `was killed by ${signal}` : `exited with code ${code}`, name));
    return child;
  }

  stopMic() {
    this.wantMic = false;
    const child = this.recorder;
    this.recorder = null;
    if (child) child.kill();
    this.pending = Buffer.alloc(0);
    this.shaper = new Shaper(this.shape);
    this.setSpeaking(false);
  }

  captured(chunk) {
    this.measure(chunk);
    if (this.inRate !== RATE) chunk = resample(this.rs, chunk, this.inRate);
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= FRAME_BYTES) {
      const frame = Buffer.from(this.pending.subarray(0, FRAME_BYTES));
      this.pending = this.pending.subarray(FRAME_BYTES);
      const { speaking, frames } = this.shaper.push(frame);
      for (const f of frames) this.send(f.toString('base64'));
      this.stats.sent += frames.length;
      this.setSpeaking(speaking);
    }
  }

  /// How the recorder really delivers: how much at a time, and at what rate. A recorder that
  /// ignores -r 16000 (the device's own 48 kHz, say) is found after two seconds and converted.
  measure(chunk) {
    const now = Date.now();
    const m = this.cap;
    if (!m.t0) {
      // time starts at the first read, so its bytes took no time: count from the next one
      m.t0 = now;
      return;
    }
    m.maxChunk = Math.max(m.maxChunk, chunk.length);
    if (m.decided) return;
    m.bytes += chunk.length;
    const secs = (now - m.t0) / 1000;
    if (secs < 2) return;
    m.decided = true;
    const hz = m.bytes / 2 / secs;
    m.hz = Math.round(hz);
    const near = RATES.reduce((a, b) => (Math.abs(b - hz) < Math.abs(a - hz) ? b : a));
    if (near !== RATE && Math.abs(hz / near - 1) < 0.1) {
      this.inRate = near;
      this.emit('info', `the mic records at ${near} Hz, not ${RATE}: converting`);
    }
  }

  setSpeaking(on) {
    if (this.speaking === on) return;
    this.speaking = on;
    this.emit('speaking', on);
  }

  /// What /voice stats shows: what came in and went out, what was dropped, and which command
  /// is playing and recording (after any fallbacks).
  report() {
    const kb = (n) => `${Math.round(n / 1024)} KB`;
    const cmd = (c) => (c ? (c.spawnargs || []).join(' ').slice(0, 90) : 'not running');
    return [
      `heard   ${this.stats.frames} frames, ${kb(this.stats.bytes)} (${(this.stats.bytes / (RATE * 2)).toFixed(1)} s of voice)`,
      `dropped ${kb(this.stats.dropped)} to catch up · ${this.stats.gaps} gaps over 200 ms while someone spoke`,
      `arrives ${this.stats.activeMs ? ((this.stats.activeBytes / (RATE * 2)) / (this.stats.activeMs / 1000)).toFixed(2) : '-'}x real time · up to ${this.stats.burst} frames at once`,
      `mic in  ${this.cap.hz ? this.cap.hz + ' Hz measured' : 'measuring'}${this.inRate !== RATE ? ', converted from ' + this.inRate : ''} · up to ${Math.round(this.cap.maxChunk / (RATE * 2) * 1000)} ms per read`,
      `sent    ${this.stats.sent} frames from this mic · gate ${Math.round(this.shaper.threshold)} · gain ${this.shaper.gain.toFixed(1)}x`,
      `player  ${cmd(this.player)}${this.broken.player ? ' · broken' : ''} (way ${this.variant.player + 1})`,
      `mic     ${cmd(this.recorder)}${this.broken.recorder ? ' · broken' : ''} (way ${this.variant.recorder + 1})`,
      `devices in: ${this.devices.input || 'system default'} · out: ${this.devices.output || 'system default'}`,
    ].join('\n');
  }

  /// Switch the mic or the speaker to another device (null: the system's), live: the tool
  /// starts again on it, and anything that failed on the old one is tried afresh.
  setDevice(kind, name) {
    const which = kind === 'input' ? 'recorder' : 'player';
    this.devices[kind] = name || null;
    this.variant[which] = 0;
    this.broken[which] = false;
    const child = this[which];
    this[which] = null;
    if (child) {
      if (which === 'player') child.stdin.end();
      child.kill();
    }
    if (which === 'recorder' && this.wantMic) {
      this.pending = Buffer.alloc(0);
      this.startMic();
    }
  }

  // MARK: speaker

  /// A frame someone else said.
  play(from, data) {
    const bytes = Buffer.from(String(data || ''), 'base64');
    if (!bytes.length) return;
    const now = Date.now();
    const q = this.queues.get(from) || { buf: Buffer.alloc(0), playing: false, last: 0, low: Infinity, lowSince: 0 };
    q.buf = Buffer.concat([q.buf, bytes]);
    const st = this.stats;
    st.frames++;
    st.bytes += bytes.length;
    // how the audio arrives: lumps of frames at once, and how fast against real time
    const gap = now - (this.lastArrival || 0);
    st.run = gap < 10 ? st.run + 1 : 1;
    st.burst = Math.max(st.burst, st.run);
    if (gap < 2000) {
      st.activeMs += gap;
      st.activeBytes += bytes.length;
    }
    this.lastArrival = now;
    if (q.buf.length > HARD_LAG) {
      st.dropped += q.buf.length - KEEP_LAG;
      q.buf = q.buf.subarray(q.buf.length - KEEP_LAG);
    }
    if (q.last && now - q.last > 200 && q.playing) st.gaps++;
    q.last = now;
    this.queues.set(from, q);
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /// Feed the player what wall time says is due since it started, so a late timer catches up
  /// instead of letting the delay grow. Nothing to play: stop the clock, let the player drain.
  tick(now = Date.now()) {
    // a speaker starts once it has enough buffered, or once nothing more is coming
    const live = [...this.queues.entries()].filter(([, q]) => q.playing || q.buf.length >= PREBUFFER || now - q.last > 100);
    const flushing = this.clock && now - this.lastVoice < FLUSH_MS;
    if (!live.length && !flushing) {
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
    if (live.length) this.lastVoice = now;
    const chunks = [];
    for (const [name, q] of live) {
      q.playing = true;
      chunks.push(q.buf.subarray(0, due));
      q.buf = q.buf.subarray(Math.min(due, q.buf.length));
      // the least this queue held over the window: if even that is long, the speaker is ahead
      if (!q.lowSince) q.lowSince = now;
      q.low = Math.min(q.low, q.buf.length);
      if (now - q.lowSince >= LAG_WINDOW) {
        if (q.low > STANDING_LAG) {
          const cut = Math.min(q.low - KEEP_LAG, q.buf.length);
          this.stats.dropped += cut;
          q.buf = q.buf.subarray(cut);
        }
        q.low = Infinity;
        q.lowSince = now;
      }
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
    if (this.broken.player) return;
    if (!this.player) {
      if (!this.tools.play) {
        this.broken.player = true;
        this.emit('error', `no player for the speaker · ${this.tools.hint}`);
        return;
      }
      this.launch('player').stdin.on('error', () => {});
    }
    this.player.stdin.write(buf);
  }

  /// A recorder or player ended. One that quit at once did not work: try its next variant,
  /// quietly; with none left, say why once and leave that half off for this call. One that ran
  /// and then stopped is started again when it is next needed.
  lost(which, child, why, cmd) {
    if (this[which] !== child) return;
    this[which] = null;
    const part = which === 'recorder' ? 'mic' : 'speaker';
    if (which === 'recorder') this.setSpeaking(false);
    const said = child.said.trim().split('\n').filter(Boolean).pop();
    if (Date.now() - child.startedAt < QUICK_EXIT_MS) {
      if (this.variant[which] + 1 < child.variants) {
        this.variant[which]++;
        if (which === 'recorder') this.startMic();
        return;
      }
      this.broken[which] = true;
      this.emit('error', `${part} does not work (tried ${child.variants} ways; the last: ${cmd} ${why})${said ? ' · ' + said : ''} · MC_VOICE_${which === 'recorder' ? 'REC' : 'PLAY'} sets another command`);
      return;
    }
    this.emit('error', `${part} stopped: ${cmd} ${why}${said ? ' · ' + said : ''}`);
    if (which === 'recorder' && this.wantMic) this.startMic();
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

module.exports = { Audio, Shaper, tools, rms, mix, resample, listDevices, resolveDevice, withDevice, loadPrefs, savePrefs, RATE, FRAME_BYTES, FRAME_MS };
