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
// Codex approvals, generic y/n prompts. Deliberately strict, as herdr does: a miss shows idle,
// never blocked, and nothing is typed on a false idle because the owner sees the screen.
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
  // an agent that has not been logged in yet is waiting for a person, not for work
  /Sign in with|Press enter to continue|paste your API key/i,
];

// Rows that belong to a dialog rather than to normal output: options, pointers, box borders.
const FURNITURE = /^\s*(❯|›|>|\d+\.|\(|[╭╰│─├┤┃┏┗]|esc\b|enter\b|\[|yes\b|no\b|tab\b|↑|↓|allow\b|deny\b|always\b|approve\b|reject\b|accept\b|cancel\b)/i;

/// The question the agent is stuck on, or null. A question counts only while it is still the
/// bottom of the screen: once ordinary output follows it, it was answered.
const blockedReason = (rows) => {
  const tail = rows.filter(Boolean).slice(-8);
  for (let i = tail.length - 1; i >= 0; i--) {
    for (const re of BLOCKED) {
      const m = tail[i].match(re);
      if (!m) continue;
      const after = tail.slice(i + 1);
      return after.every((r) => FURNITURE.test(r)) ? m[0] : null;
    }
  }
  return null;
};

module.exports = { Screen, blockedReason };
