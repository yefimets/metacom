'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Org } = require('../lib/org.js');
const { Auth } = require('../lib/auth.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };

const fakeClient = () => {
  const handlers = {};
  return { events: [], source: '127.0.0.1', on(name, fn) { handlers[name] = fn; }, emit(name, data) { if (name === 'close') return handlers.close?.(); this.events.push([name, data]); }, close() {} };
};

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  const auth = new Auth(dir, quiet);
  const org = new Org({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const agentTok = auth.create({ name: 'a', role: 'agent' });
  const ownerConn = org.bind(fakeClient(), owner, '127.0.0.1');
  const agentClient = fakeClient();
  const agentConn = org.bind(agentClient, auth.verify(agentTok.token), '127.0.0.1');
  org.register(agentConn, { name: 'Alex', room: 'dev', caps: ['swift'] });
  return { org, ownerConn, agentConn, agentClient };
};

test('metacom: command typed into an idle agent, done badge after the turn, seen clears it', async () => {
  const { org, ownerConn, agentConn, agentClient } = setup();
  org.setStatus(agentConn, 'waiting', 'idle');
  const sent = await org.send(ownerConn, 'Alex', 'run tests');
  assert.strictEqual(sent.delivered, true);
  assert.ok(agentClient.events.some(([n, d]) => n === 'agents/message' && d.text === 'run tests'));
  org.setStatus(agentConn, 'working', 'progress');
  org.setStatus(agentConn, 'waiting', 'idle');
  assert.strictEqual(org.list(ownerConn)[0].attention, true);
  org.seen(ownerConn, 'Alex');
  assert.strictEqual(org.list(ownerConn)[0].attention, false);
});

test('metacom: blocked agents refuse commands but take control commands', async () => {
  const { org, ownerConn, agentConn } = setup();
  org.setStatus(agentConn, 'blocked', 'screen: Do you want to proceed');
  await assert.rejects(org.send(ownerConn, 'Alex', 'more work'), (e) => e.code === 409);
  const ctl = await org.send(ownerConn, 'Alex', '!keys enter');
  assert.strictEqual(ctl.delivered, true);
  assert.strictEqual(org.list(ownerConn)[0].attention, true);
  await assert.rejects(org.send(agentConn, 'Alex', '!stop'), (e) => e.code === 403);
});

test('metacom: wait resolves on a status change, and send --wait observes a turn', async () => {
  const { org, ownerConn, agentConn } = setup();
  org.setStatus(agentConn, 'waiting', 'idle');
  const waiting = org.wait(ownerConn, 'Alex', ['blocked'], 5000);
  org.setStatus(agentConn, 'blocked', 'q');
  assert.strictEqual((await waiting).status, 'blocked');
  org.setStatus(agentConn, 'waiting', 'idle');
  const turn = org.send(ownerConn, 'Alex', 'go', 'command', { timeoutMs: 5000 });
  setTimeout(() => org.setStatus(agentConn, 'working', 'progress'), 20);
  setTimeout(() => org.setStatus(agentConn, 'waiting', 'idle'), 60);
  const result = await turn;
  assert.deepStrictEqual(result.turn, { status: 'waiting', stalled: false, timeout: false });
});

test('metacom: system events, room rollups, and offline on disconnect', async () => {
  const { org, ownerConn, agentConn, agentClient } = setup();
  org.setStatus(agentConn, 'working', 'progress');
  assert.deepStrictEqual(org.rooms().find((r) => r.room === 'dev'), { room: 'dev', agents: 1, online: 1, working: 1, blocked: 0, attention: 0 });
  agentClient.emit('close');
  const list = org.list(ownerConn);
  assert.strictEqual(list[0].connected, false);
  assert.strictEqual(list[0].status, 'stopped');
  const history = org.history(ownerConn, 'dev', 10);
  assert.ok(history.some((m) => m.kind === 'system' && m.text.startsWith('Alex joined')));
  assert.ok(history.some((m) => m.kind === 'system' && m.text === 'Alex left'));
});

test('metacom: agents take commands from each other only per their accept policy; the rest arrive as notes', async () => {
  const { org, ownerConn, agentConn, agentClient } = setup();
  const auth = org.auth;
  const bobClient = fakeClient();
  const bobConn = org.bind(bobClient, auth.verify(auth.create({ name: 'b', role: 'agent' }).token), '127.0.0.1');
  org.register(bobConn, { name: 'Bob', room: 'dev', accept: 'any' });
  org.setStatus(agentConn, 'waiting', 'idle');
  org.setStatus(bobConn, 'waiting', 'idle');
  // Alex registered without accept: a command from Bob becomes a note
  const toAlex = await org.send(bobConn, 'Alex', 'run tests');
  assert.strictEqual(toAlex.kind, 'info');
  assert.strictEqual(toAlex.downgraded, true);
  assert.strictEqual(agentClient.events.find(([n, d]) => n === 'agents/message' && d.text === 'run tests')[1].kind, 'info');
  // Bob takes commands from anyone
  const toBob = await org.send(agentConn, 'Bob', 'deploy');
  assert.strictEqual(toBob.kind, 'command');
  assert.strictEqual(toBob.downgraded, undefined);
  // a list of names
  org.register(agentConn, { name: 'Alex', room: 'dev', accept: ['Bob'] });
  org.setStatus(agentConn, 'waiting', 'idle');
  assert.strictEqual((await org.send(bobConn, 'Alex', 'again')).kind, 'command');
  assert.deepStrictEqual(org.list(ownerConn).find((m) => m.name === 'Alex').accept, ['Bob']);
  assert.strictEqual(org.list(ownerConn).find((m) => m.name === 'Bob').accept, 'any');
  // the owner always may
  assert.strictEqual((await org.send(ownerConn, 'Alex', 'go')).kind, 'command');
});
