'use strict';

const fs = require('node:fs');
const path = require('node:path');

/// Append-only JSONL files under the data directory. One file per room for the stream,
/// one for directed messages, one JSON snapshot for members. Postgres can replace this
/// class later; the hub only calls append(), tail(), load() and save().
class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(path.join(dataDir, 'rooms'), { recursive: true, mode: 0o700 });
  }

  roomFile(room) {
    return path.join(this.dir, 'rooms', room + '.jsonl');
  }

  append(file, record) {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  appendRoom(room, record) {
    this.append(this.roomFile(room), record);
  }

  /// Last `limit` records of a JSONL file, optionally only those after `since` (ISO time).
  tail(file, limit = 50, since = null) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let rec = null;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (since && rec.ts <= since) break;
      out.push(rec);
    }
    return out.reverse();
  }

  tailRoom(room, limit, since) {
    return this.tail(this.roomFile(room), limit, since);
  }

  loadJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  saveJson(name, data) {
    const file = path.join(this.dir, name);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

module.exports = { Store };
