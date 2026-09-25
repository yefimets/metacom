'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };

const fakeClient = () => {
  const handlers = {};
  return { events: [], source: '127.0.0.1', on(name, fn) { handlers[name] = fn; }, emit(name, data) { if (name === 'close') return handlers.close?.(); this.events.push([name, data]); }, close() {} };
};

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const agentTok = auth.create({ name: 'a', role: 'agent' });
  const ownerConn = hub.bind(fakeClient(), owner, '127.0.0.1');
  const agentClient = fakeClient();
  const agentConn = hub.bind(agentClient, auth.verify(agentTok.token), '127.0.0.1');
  hub.register(agentConn, { name: 'Alex', room: 'dev', caps: ['swift'] });
  return { hub, ownerConn, agentConn, agentClient };
};

test('hub: command typed into an idle agent, done badge after the turn, seen clears it', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  hub.setStatus(agentConn, 'waiting', 'idle');
  const sent = await hub.send(ownerConn, 'Alex', 'run tests');
  assert.strictEqual(sent.delivered, true);
  assert.ok(agentClient.events.some(([n, d]) => n === 'agents/message' && d.text === 'run tests'));
  hub.setStatus(agentConn, 'working', 'progress');
  hub.setStatus(agentConn, 'waiting', 'idle');
  assert.strictEqual(hub.list(ownerConn)[0].attention, true);
  hub.seen(ownerConn, 'Alex');
  assert.strictEqual(hub.list(ownerConn)[0].attention, false);
});

test('hub: blocked agents refuse commands but take control commands', async () => {
  const { hub, ownerConn, agentConn } = setup();
  hub.setStatus(agentConn, 'blocked', 'screen: Do you want to proceed');
  await assert.rejects(hub.send(ownerConn, 'Alex', 'more work'), (e) => e.code === 409);
  const ctl = await hub.send(ownerConn, 'Alex', '!keys enter');
  assert.strictEqual(ctl.delivered, true);
  assert.strictEqual(hub.list(ownerConn)[0].attention, true);
  await assert.rejects(hub.send(agentConn, 'Alex', '!stop'), (e) => e.code === 403);
});

test('hub: wait resolves on a status change, and send --wait observes a turn', async () => {
  const { hub, ownerConn, agentConn } = setup();
  hub.setStatus(agentConn, 'waiting', 'idle');
  const waiting = hub.wait(ownerConn, 'Alex', ['blocked'], 5000);
  hub.setStatus(agentConn, 'blocked', 'q');
  assert.strictEqual((await waiting).status, 'blocked');
  hub.setStatus(agentConn, 'waiting', 'idle');
  const turn = hub.send(ownerConn, 'Alex', 'go', 'command', { timeoutMs: 5000 });
  setTimeout(() => hub.setStatus(agentConn, 'working', 'progress'), 20);
  setTimeout(() => hub.setStatus(agentConn, 'waiting', 'idle'), 60);
  const result = await turn;
  assert.deepStrictEqual(result.turn, { status: 'waiting', stalled: false, timeout: false });
});

test('hub: system events, room rollups, and offline on disconnect', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  hub.setStatus(agentConn, 'working', 'progress');
  assert.deepStrictEqual(hub.rooms().find((r) => r.room === 'dev'), { room: 'dev', agents: 1, online: 1, working: 1, blocked: 0, attention: 0 });
  agentClient.emit('close');
  const list = hub.list(ownerConn);
  assert.strictEqual(list[0].connected, false);
  assert.strictEqual(list[0].status, 'stopped');
  const history = hub.history(ownerConn, 'dev', 10);
  assert.ok(history.some((m) => m.kind === 'system' && m.text.startsWith('Alex joined')));
  assert.ok(history.some((m) => m.kind === 'system' && m.text === 'Alex left'));
});

test('hub: agents take commands from each other only per their accept policy; the rest arrive as notes', async () => {
  const { hub, ownerConn, agentConn, agentClient } = setup();
  const auth = hub.auth;
  const bobClient = fakeClient();
  const bobConn = hub.bind(bobClient, auth.verify(auth.create({ name: 'b', role: 'agent' }).token), '127.0.0.1');
  hub.register(bobConn, { name: 'Bob', room: 'dev', accept: 'any' });
  hub.setStatus(agentConn, 'waiting', 'idle');
  hub.setStatus(bobConn, 'waiting', 'idle');
  // Alex registered without accept: a command from Bob becomes a note
  const toAlex = await hub.send(bobConn, 'Alex', 'run tests');
  assert.strictEqual(toAlex.kind, 'info');
  assert.strictEqual(toAlex.downgraded, true);
  assert.strictEqual(agentClient.events.find(([n, d]) => n === 'agents/message' && d.text === 'run tests')[1].kind, 'info');
  // Bob takes commands from anyone
  const toBob = await hub.send(agentConn, 'Bob', 'deploy');
  assert.strictEqual(toBob.kind, 'command');
  assert.strictEqual(toBob.downgraded, undefined);
  // a list of names
  hub.register(agentConn, { name: 'Alex', room: 'dev', accept: ['Bob'] });
  hub.setStatus(agentConn, 'waiting', 'idle');
  assert.strictEqual((await hub.send(bobConn, 'Alex', 'again')).kind, 'command');
  assert.deepStrictEqual(hub.list(ownerConn).find((m) => m.name === 'Alex').accept, ['Bob']);
  assert.strictEqual(hub.list(ownerConn).find((m) => m.name === 'Bob').accept, 'any');
  // the owner always may
  assert.strictEqual((await hub.send(ownerConn, 'Alex', 'go')).kind, 'command');
});

test('hub: rooms are safe file names, and a room is listed once a human or a log is in it', () => {
  const { hub, ownerConn } = setup();
  for (const bad of ['../x', 'a/b', '.hidden', '', 'x'.repeat(65)]) {
    assert.throws(() => hub.register(ownerConn, { name: 'misha', kind: 'human', room: bad }), (e) => e.code === 400, bad);
  }
  assert.throws(() => hub.join(ownerConn, '../etc'), (e) => e.code === 400);
  assert.throws(() => hub.say(ownerConn, '../etc', 'hi'), (e) => e.code === 400);
  assert.strictEqual(hub.members.get('misha'), undefined);
  hub.register(ownerConn, { name: 'misha', kind: 'human', room: 'plans' });
  assert.deepStrictEqual(hub.rooms().find((r) => r.room === 'plans'), { room: 'plans', agents: 0, online: 0, working: 0, blocked: 0, attention: 0 });
  hub.say(ownerConn, 'notes', 'kept');
  assert.ok(hub.rooms().some((r) => r.room === 'notes'));
});
