'use strict';

const time = (ts) => (ts || '').slice(11, 19);

const line = (msg) => {
  if (msg.kind === 'system') return `${time(msg.ts)} · ${msg.text}`;
  const to = msg.to ? ` → ${msg.to}` : '';
  const kind = msg.kind === 'say' ? '' : ` [${msg.kind}]`;
  return `${time(msg.ts)} ${msg.from.name}${to}${kind}: ${msg.text}`;
};

const member = (m) => {
  const repo = m.repo ? ` ${m.repo}` : '';
  const caps = m.caps && m.caps.length ? ` [${m.caps.join(',')}]` : '';
  const host = m.host ? ` @${m.host}` : '';
  const status = m.connected ? (m.attention && m.status !== 'blocked' ? 'done' : m.status) : 'stopped';
  const mark = status === 'blocked' ? '!' : m.attention ? '*' : m.connected ? '●' : '○';
  const why = m.reason && status !== 'stopped' && (status === 'blocked' || status === 'working') ? ` (${m.reason})` : '';
  return `${mark} ${m.name.padEnd(14)} ${status.padEnd(8)} ${m.room}${host}${repo}${caps}${why}`;
};

module.exports = { line, member, time };
