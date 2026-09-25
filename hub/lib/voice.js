'use strict';

const { ROOM } = require('./store.js');
const { fail } = require('./errors.js');

/// The wire format every client speaks: signed 16-bit little-endian PCM, mono, 16 kHz, in
/// frames of at most FRAME_MS, base64 in the event. No codec to agree on, and a terminal
/// client can pipe it straight into sox or ffmpeg.
const RATE = 16_000;
const FRAME_MS = 100; // the most a frame may hold; clients send 40
const MAX_FRAME = Math.ceil(((RATE * 2 * FRAME_MS) / 1000) * 1.5); // bytes, with room for a late flush
const MAX_B64 = Math.ceil(MAX_FRAME / 3) * 4;
// Frames arrive only while someone talks (clients gate them on their own voice detection):
// the hub calls a speaker quiet once their frames stop for this long.
const QUIET_MS = 450;
// Audio has its own budget, apart from the RPC one: 25 frames a second, with slack for the
// pre-roll a client sends when a voice starts.
const FRAME_WINDOW = 2_000;
const FRAME_CALLS = 150;
// Every so often the hub logs, per sender, how their audio really arrives: that is where a
// choppy call is diagnosed (a recorder that lumps its output, one faster than real time).
const REPORT_MS = 10_000;

/// Room calls, Discord style: anyone in a room can join its call, with the mic on or muted.
/// Membership belongs to a connection (the chat window you joined from), the roster to names,
/// so one person on the phone and in the terminal is one line. The hub only relays: audio it
/// receives from a live mic goes to every other connection in the same call.
class Voice {
  constructor(hub) {
    this.hub = hub;
    this.speaking = new Map(); // "room\nname" -> quiet timer
    hub.events.on('conn/closed', (conn) => {
      if (conn.voice) this.leave(conn);
    });
  }

  /// Join a room's call (again), or change the mic. `mic` defaults to on: joining is talking.
  join(conn, room, mic = true, tool = null) {
    if (conn.ephemeral) throw fail(400, 'Join a call over a websocket connection');
    room = String(room || '') || (conn.room !== '*' ? conn.room : '');
    if (!ROOM.test(room)) throw fail(400, 'room is required');
    if (conn.record.role !== 'owner' && conn.room !== room) throw fail(403, 'Not your room');
    const before = conn.voice;
    if (before && before.room !== room) this.leave(conn);
    conn.voice = { room, mic: Boolean(mic), since: before && before.room === room ? before.since : new Date().toISOString(), tool: tool ? String(tool).slice(0, 160) : before?.tool || 'web' };
    if (!conn.voice.mic) this.quiet(room, this.nameOf(conn), false);
    this.changed(room);
    return this.state(room);
  }

  mic(conn, on) {
    if (!conn.voice) throw fail(409, 'Not in a call');
    if (!on) this.report(conn);
    return this.join(conn, conn.voice.room, on);
  }

  leave(conn) {
    const was = conn.voice;
    if (!was) return { room: null, participants: [] };
    this.report(conn, was);
    conn.voice = null;
    const name = this.nameOf(conn);
    if (!this.connsOf(was.room).some((c) => this.nameOf(c) === name)) this.quiet(was.room, name, false);
    this.changed(was.room);
    return this.state(was.room);
  }

  /// A frame from a live mic, to everyone else in the call. Frames from a muted or absent
  /// connection are dropped without an error: they are in flight when the mute lands.
  frame(conn, data) {
    this.budget(conn);
    const call = conn.voice;
    if (!call || !call.mic) return { ok: false };
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_B64 || data.length % 4 !== 0) throw fail(400, 'frame: base64 PCM16 up to 150 ms');
    const from = this.nameOf(conn);
    this.track(conn, from, call, data.length);
    const key = `${call.room}\n${from}`;
    const wasQuiet = !this.speaking.has(key);
    clearTimeout(this.speaking.get(key));
    this.speaking.set(key, setTimeout(() => this.quiet(call.room, from), QUIET_MS));
    if (wasQuiet) this.changed(call.room);
    const packet = { room: call.room, from, data };
    for (const other of this.connsOf(call.room)) {
      if (other === conn || this.nameOf(other) === from) continue;
      this.hub.emit(other.client, 'voice/frame', packet);
    }
    return { ok: true };
  }

  track(conn, from, call, b64) {
    const now = Date.now();
    const s = conn.vstats || (conn.vstats = { frames: 0, bytes: 0, activeMs: 0, activeBytes: 0, run: 0, burst: 0, last: 0 });
    const bytes = (b64 / 4) * 3;
    const gap = now - s.last;
    s.frames++;
    s.bytes += bytes;
    s.run = gap < 10 ? s.run + 1 : 1;
    s.burst = Math.max(s.burst, s.run);
    if (gap < 2000) {
      s.activeMs += gap;
      s.activeBytes += bytes;
    }
    s.last = now;
    if (!s.since) s.since = now;
    if (now - s.since >= REPORT_MS) this.report(conn, call);
  }

  /// One log line for what a sender delivered since the last one; also when they mute or leave.
  report(conn, call = conn.voice) {
    const s = conn.vstats;
    if (!s || !call) return;
    conn.vstats = null;
    const x = s.activeMs ? (s.activeBytes / (RATE * 2) / (s.activeMs / 1000)).toFixed(2) : '-';
    this.hub.console.log(`voice: ${this.nameOf(conn)} in ${call.room}: ${s.frames} frames, ${Math.round(s.bytes / 1024)} KB, ${x}x real time, up to ${s.burst} at once · ${call.tool}`);
  }

  quiet(room, name, announce = true) {
    const key = `${room}\n${name}`;
    if (!this.speaking.has(key)) return;
    clearTimeout(this.speaking.get(key));
    this.speaking.delete(key);
    if (announce) this.changed(room);
  }

  budget(conn) {
    const t = Date.now();
    conn.frames = (conn.frames || []).filter((x) => t - x < FRAME_WINDOW);
    conn.frames.push(t);
    if (conn.frames.length > FRAME_CALLS) throw fail(429, 'Too many voice frames');
  }

  nameOf(conn) {
    return conn.name || conn.record.name;
  }

  connsOf(room) {
    return [...this.hub.conns.values()].filter((c) => c.voice && c.voice.room === room);
  }

  /// Who is in the call: one entry per name, mic on if any of their connections has it on.
  state(room) {
    const byName = new Map();
    for (const c of this.connsOf(room)) {
      const name = this.nameOf(c);
      const seen = byName.get(name);
      if (seen) {
        seen.mic = seen.mic || c.voice.mic;
        if (c.voice.since < seen.since) seen.since = c.voice.since;
      } else {
        byName.set(name, { name, mic: c.voice.mic, since: c.voice.since });
      }
    }
    const participants = [...byName.values()]
      .map((p) => ({ ...p, speaking: p.mic && this.speaking.has(`${room}\n${p.name}`) }))
      .sort((a, b) => a.since.localeCompare(b.since) || a.name.localeCompare(b.name));
    return { room, participants };
  }

  /// Every room with a call going, for a client that just connected.
  calls() {
    const rooms = new Set();
    for (const c of this.hub.conns.values()) if (c.voice) rooms.add(c.voice.room);
    return [...rooms].sort().map((room) => this.state(room));
  }

  changed(room) {
    this.hub.broadcast('voice/changed', this.state(room), room);
  }
}

module.exports = { Voice, RATE, FRAME_MS };
