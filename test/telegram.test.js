'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');
const { Telegram, parse, format } = require('../lib/telegram.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };

const fakeClient = () => {
  const handlers = {};
  return { events: [], source: '127.0.0.1', on(name, fn) { handlers[name] = fn; }, emit(name, data) { if (name === 'close') return handlers.close?.(); this.events.push([name, data]); }, close() {} };
};

/// A Telegram API in memory: hands out queued updates once, records every sendMessage.
const fakeTelegram = () => {
  const pending = [];
  const sent = [];
  let update = 1;
  const fetchImpl = async (url, { body }) => {
    const method = url.split('/').pop();
    const args = JSON.parse(body);
    let result = true;
    if (method === 'getUpdates') {
      result = pending.splice(0).map((message) => ({ update_id: update++, message }));
    } else if (method === 'sendMessage') {
      sent.push(args);
    }
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  const from = { id: 42, username: 'misha', first_name: 'Misha' };
  const stranger = { id: 7, username: 'someone' };
  const say = (text, user = from) => pending.push({ chat: { id: -100, title: 'dev chat' }, from: user, text });
  return { fetchImpl, sent, say, from, stranger };
};

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tg-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  const agentTok = auth.create({ name: 'a', role: 'agent' });
  const agentClient = fakeClient();
  const agentConn = hub.bind(agentClient, auth.verify(agentTok.token), '127.0.0.1');
  hub.register(agentConn, { name: 'Alex', room: 'dev', host: 'vm' });
  hub.setStatus(agentConn, 'waiting', 'idle');
  const tg = fakeTelegram();
  const telegram = new Telegram({ hub, console: quiet, botToken: 't', dataDir: dir, fetchImpl: tg.fetchImpl });
  telegram.start();
  // one poll round: getUpdates returns what was queued, then each update is handled
  const round = async () => {
    const updates = await telegram.api('getUpdates', {});
    for (const u of updates) await telegram.onUpdate(u.message);
    await telegram.queue;
  };
  telegram.stop();
  return { dir, hub, ownerConn, agentConn, agentClient, tg, telegram, round };
};

test('telegram: parse mirrors the phone composer', () => {
  assert.deepStrictEqual(parse('@Alex run tests'), { kind: 'command', to: 'Alex', text: 'run tests' });
  assert.deepStrictEqual(parse('@auto fix the build'), { kind: 'dispatch', text: 'fix the build' });
  assert.deepStrictEqual(parse('@room hi all'), { kind: 'say', text: 'hi all' });
  assert.deepStrictEqual(parse('plain words'), { kind: 'say', text: 'plain words' });
  assert.deepStrictEqual(parse('/join@hubbot dev'), { kind: 'slash', name: 'join', arg: 'dev' });
});

test('telegram: format hides system lines and what came from the group', () => {
  assert.strictEqual(format({ kind: 'system', from: { name: 'hub' }, text: 'x joined' }), null);
  assert.strictEqual(format({ kind: 'say', from: { name: 'tg:misha' }, text: 'echo' }), null);
  assert.strictEqual(format({ kind: 'command', from: { name: 'misha' }, to: 'Alex', text: 'go', media: [{ name: 'a.png' }] }), 'misha > Alex: go [a.png]');
});

test('telegram: first /join claims the owner, binds the group, and strangers only read', async () => {
  const { tg, telegram, round, dir } = setup();
  tg.say('/join dev', tg.stranger);
  await round();
  // the stranger was first, so the stranger is the owner of this bot: trust on first use
  assert.strictEqual(telegram.state.owner, 'someone');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'telegram.json'), 'utf8')).chats['-100'].room, 'dev');
  assert.match(tg.sent.at(-1).text, /joined room dev/);
  tg.say('/leave', tg.from);
  await round();
  assert.strictEqual(telegram.state.chats['-100'].room, 'dev', 'a non-owner cannot unbind');
});

test('telegram: owner messages flow into the room and to agents, the room flows back', async () => {
  const { hub, tg, agentClient, round, telegram } = setup();
  telegram.owner = 'misha';
  tg.say('/join dev');
  tg.say('hello room');
  tg.say('@Alex run tests');
  tg.say('ignored', tg.stranger);
  await round();
  const history = hub.history(hub.local('t'), 'dev', 50);
  assert.ok(history.some((m) => m.kind === 'say' && m.text === 'hello room' && m.from.name === 'tg:misha'));
  assert.ok(agentClient.events.some(([n, d]) => n === 'agents/message' && d.text === 'run tests' && d.kind === 'command'));
  assert.ok(!history.some((m) => m.text === 'ignored'));
  // nothing typed in the group is echoed back to it
  assert.ok(!tg.sent.some((s) => /hello room|run tests/.test(s.text)));
  // an agent's answer in the room reaches the group; so does a blocked agent
  const agentConn = hub.conns.get(agentClient);
  hub.say(agentConn, 'dev', 'tests pass');
  hub.setStatus(agentConn, 'blocked', 'screen: Do you want to proceed?');
  await telegram.queue;
  assert.ok(tg.sent.some((s) => s.chat_id === '-100' && s.text === 'Alex: tests pass'));
  assert.ok(tg.sent.some((s) => s.text === 'Alex needs you: Do you want to proceed?'));
});

test('telegram: /agents lists the room, /read asks the wrapper for the screen', async () => {
  const { hub, tg, agentClient, round, telegram } = setup();
  telegram.owner = '42';
  tg.say('/join dev');
  tg.say('/agents');
  await round();
  assert.match(tg.sent.at(-1).text, /waiting {2}Alex @ vm/);
  tg.say('/read Alex');
  const reading = round();
  // the wrapper answers the read request the hub sent it
  await new Promise((r) => setTimeout(r, 20));
  const req = agentClient.events.find(([n]) => n === 'agents/readRequest');
  hub.readReply(hub.conns.get(agentClient), req[1].id, '> claude\n$ ');
  await reading;
  assert.match(tg.sent.at(-1).text, /claude/);
  assert.strictEqual(tg.sent.at(-1).parse_mode, 'Markdown');
});
