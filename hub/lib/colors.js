'use strict';

/// Name colours, one per member, kept by the hub so a name has the same colour in every room and
/// on every machine, and no two names in a room share one. The chat draws index `color` from its
/// palette (cli/src/chat/palette.ts, the same order); a client that knows nothing of this falls
/// back to the hash of the name over the first ten, which is also where everyone starts.
///
/// People move between rooms, so a human's colour is theirs everywhere: agents never take it.
/// Only humans about (connected, or seen in the last two days) hold theirs everywhere; a test name
/// from last week does not keep twenty agents off their colours. An agent's is unique in its own
/// room. When the palette runs out, the least used one is shared.

const COLORS = 20;
const LEGACY = 10; // the palette before it grew: a name keeps the colour it always had if it can

// FNV-1a over the code points of the lower-cased name, as palette.ts has it
const hash = (name) => {
  let h = 2166136261;
  for (const ch of String(name).toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};

const legacy = (name) => hash(name) % LEGACY;

const ABOUT_MS = 2 * 24 * 3600 * 1000;
const about = (m, now = Date.now()) => m.kind === 'human' && (m.connected || now - Date.parse(m.lastSeen || 0) < ABOUT_MS);

/// Colours the member may not take: every other human's, and those of the others in its room;
/// for a human, also every agent's in its own room.
const taken = (member, all) => {
  const out = new Set();
  for (const m of all) {
    if (m === member || m.name === member.name || typeof m.color !== 'number') continue;
    if (about(m) || m.room === member.room) out.add(m.color);
  }
  return out;
};

/// The colour for `member` among `all`: the one it has, if nobody it could meet has it; else
/// the one its name always had; else the free one used least; else the least used of all.
const pick = (member, all) => {
  const busy = taken(member, all);
  if (typeof member.color === 'number' && member.color < COLORS && !busy.has(member.color)) return member.color;
  const mine = legacy(member.name);
  if (!busy.has(mine)) return mine;
  const use = new Array(COLORS).fill(0);
  for (const m of all) if (m !== member && typeof m.color === 'number' && m.color < COLORS) use[m.color]++;
  const order = [...use.keys()].sort((a, b) => use[a] - use[b] || a - b);
  return order.find((c) => !busy.has(c)) ?? order[0];
};

/// Colours for everyone who has none yet: humans first (theirs must hold in every room), then
/// agents, the ones seen most recently first, so the colours people know stay put.
const assignAll = (members) => {
  const all = [...members];
  const order = all
    .filter((m) => typeof m.color !== 'number')
    .sort((a, b) => (a.kind === 'human' ? 0 : 1) - (b.kind === 'human' ? 0 : 1) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  for (const m of order) m.color = pick(m, all);
  return order.length;
};

module.exports = { COLORS, pick, assignAll, legacy };
