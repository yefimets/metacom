'use strict';

const { Terminal } = require('@xterm/headless');

/// A headless terminal that follows the agent's output, so the wrapper can look at the real
/// screen (including Claude Code's alternate screen) instead of guessing from raw bytes.
/// herdr classifies agents from the bottom of the live screen; this does the same.
class Screen {
  constructor(cols, rows) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 500 });
  }

  write(data) {
    this.term.write(data);
  }

  resize(cols, rows) {
    this.term.resize(cols, rows);
  }

  /// Last `count` non-empty rendered rows, oldest first.
  lines(count = 40) {
    const buffer = this.term.buffer.active;
    const out = [];
    for (let i = buffer.length - 1; i >= 0 && out.length < count; i--) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true).trimEnd();
      if (text || out.length) out.push(text);
    }
    return out.reverse();
  }

  /// The visible viewport only (rows on screen), for blocked detection.
  visible() {
    const buffer = this.term.buffer.active;
    const rows = this.term.rows;
    const out = [];
    const top = Math.max(0, Math.min(buffer.baseY, buffer.length - rows));
    for (let i = top; i < Math.min(buffer.length, top + rows); i++) {
      const line = buffer.getLine(i);
      if (line) out.push(line.translateToString(true).trimEnd());
    }
    return out;
  }
}

// Visible shapes of "the agent needs an answer": Claude Code permission and question dialogs,
// Codex approvals, opencode permission prompts, generic y/n prompts. Deliberately strict, as
// herdr does: a miss shows idle, never blocked, and nothing is typed on a false idle because
// the owner sees the screen. MC_BLOCKED adds patterns for a harness not listed here
// (case-insensitive, one regex per line or separated by |||).
const BLOCKED = [
  /Do you want to (proceed|make this edit|run|allow|create)/i,
  /Esc to cancel|Enter to confirm|Enter to select/i,
  /Yes, (allow|and don't ask|don't ask again)/i,
  /tell Claude what to do/i,
  /\(y\/n\)|\[Y\/n\]|\[y\/N\]/,
  /Allow (this )?command\?|Approve\?|approval required/i,
  /Quick safety check|trust this folder/i,
  /Select an option|Choose an option/i,
  /Permission required|Allow always|Always allow/i,
  ...String(process.env.MC_BLOCKED || '')
    .split(/\|\|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s, 'i')),
];

// Rows that belong to a dialog rather than to normal output: options, pointers, box borders.
const FURNITURE = /^\s*(❯|›|>|\d+\.|\(|[╭╰│─├┤┃┏┗]|esc\b|enter\b|\[|yes\b|no\b|tab\b|↑|↓|allow\b|deny\b|always\b|approve\b|reject\b|accept\b|cancel\b)/i;

/// The question the agent is stuck on, or null. A question counts only while it is still the
/// bottom of the screen: once ordinary output follows it, it was answered.
const blockedReason = (rows) => {
  const tail = rows.filter(Boolean).slice(-8);
  const hits = [];
  for (let i = 0; i < tail.length; i++) {
    for (const re of BLOCKED) {
      const m = tail[i].match(re);
      if (m) {
        hits.push({ i, text: m[0] });
        break;
      }
    }
  }
  if (hits.length === 0) return null;
  // The lowest match must still be the bottom of the screen: once ordinary output follows, it
  // was answered. The highest one is the question itself, the ones below it are its options.
  const last = hits[hits.length - 1];
  if (!tail.slice(last.i + 1).every((r) => FURNITURE.test(r))) return null;
  const first = hits[0];
  // "esc to cancel" and friends are chrome, not the question: take the line above them.
  if (FURNITURE.test(tail[first.i])) {
    for (let i = first.i - 1; i >= 0; i--) if (!FURNITURE.test(tail[i])) return tail[i].trim().slice(0, 120);
  }
  return first.text;
};

module.exports = { Screen, blockedReason };
