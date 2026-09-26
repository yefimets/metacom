'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/// One Claude Code conversation per thread of the room. A command that replies to a message
/// (`replyTo`) carries on that message's thread, so the agent goes back to the conversation it
/// had there; a command that replies to nothing starts a thread and a clean context. Notes are
/// typed into whatever conversation is open.
///
/// Claude Code tells which conversation is open through a SessionStart hook (on start, on
/// resume, after /clear): the wrapper passes the hook in `--settings`, the hook appends its JSON
/// to a file, and this class reads it. The thread -> session map outlives the wrapper, so a
/// restarted agent picks its last conversation up again.

const DIR = path.join(os.homedir(), '.local', 'share', 'metacom-hub', 'sessions');
const KEEP = 200;

/// Whether Claude Code has the conversation on disk: it keeps them under ~/.claude/projects/,
/// in a folder named after the working directory with every other character turned into '-'.
const transcriptExists = (cwd, id, home = os.homedir()) =>
  fs.existsSync(path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`));

class Threads {
  constructor({ name, cwd, dir = DIR }) {
    this.cwd = cwd;
    this.file = path.join(dir, `${name}.json`);
    this.hookFile = path.join(dir, `${name}.${process.pid}.hook.jsonl`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.hookFile, '');
    this.read = 0;
    this.current = null; // the session Claude says is open
    this.used = false; // whether a command went into it since it was opened
    this.waiters = [];
    const saved = this.load();
    // conversations live under the folder they were started in; another folder cannot resume them
    this.byThread = saved.cwd === cwd ? saved.byThread || {} : {};
    this.last = saved.cwd === cwd ? saved.last || null : null;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  save() {
    const entries = Object.entries(this.byThread).slice(-KEEP);
    this.byThread = Object.fromEntries(entries);
    fs.writeFileSync(this.file, JSON.stringify({ cwd: this.cwd, last: this.current || this.last, byThread: this.byThread }, null, 2) + '\n', { mode: 0o600 });
  }

  /// The `--settings` value that makes Claude Code report every session it opens.
  settings() {
    const hook = { type: 'command', command: 'cat >> "$MC_SESSION_FILE"; echo >> "$MC_SESSION_FILE"' };
    return JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook] }] } });
  }

  /// New lines from the hook: the open session changes. Returns the sessions seen.
  poll() {
    let text = '';
    try {
      const buf = fs.readFileSync(this.hookFile);
      // only whole lines: a line the hook is still writing is read next time
      const end = buf.lastIndexOf(10) + 1;
      if (end <= this.read) return [];
      text = buf.subarray(this.read, end).toString('utf8');
      this.read = end;
    } catch {
      return [];
    }
    const seen = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const { session_id: id, source } = JSON.parse(line);
        if (!id) continue;
        this.opened(id, source);
        seen.push({ id, source });
      } catch {
        // not JSON: not from the hook
      }
    }
    return seen;
  }

  opened(id, source) {
    const changed = id !== this.current;
    this.current = id;
    // a resumed conversation has its history; a new one or a cleared one is empty
    if (changed) this.used = source === 'resume';
    this.save();
    for (const w of this.waiters.splice(0)) w(id);
  }

  /// What to do before typing `msg`: type it where we are, clear first, or go back to the
  /// thread's conversation.
  plan(msg) {
    if (msg.kind !== 'command') return { action: 'type' };
    if (msg.replyTo) {
      const sid = this.byThread[msg.thread];
      if (sid && sid !== this.current) return { action: 'resume', sid };
      return { action: 'type' };
    }
    return this.used ? { action: 'clear' } : { action: 'type' };
  }

  /// The command went in: its thread now lives in the open conversation.
  typed(msg) {
    if (msg.kind !== 'command') return;
    this.used = true;
    if (this.current && msg.thread) {
      delete this.byThread[msg.thread]; // most recent last, so trimming drops the oldest
      this.byThread[msg.thread] = this.current;
    }
    this.save();
  }

  /// Resolves with the next session Claude reports (after /clear or a restart), or null.
  next(timeoutMs = 8000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(null);
      }, timeoutMs);
      const done = (id) => {
        clearTimeout(timer);
        resolve(id);
      };
      this.waiters.push(done);
    });
  }

  close() {
    try {
      fs.unlinkSync(this.hookFile);
    } catch {
      // gone already
    }
  }
}

module.exports = { Threads, transcriptExists };
