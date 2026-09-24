'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hub } = require('../lib/hub.js');
const { Auth } = require('../lib/auth.js');
const { heuristic } = require('../lib/router.js');

const quiet = { log() {}, warn() {}, info() {}, error() {} };
const client = () => {
  let onClose;
  return {
    events: [],
    on(event, callback) { if (event === 'close') onClose = callback; },
    emit(event, data) { this.events.push({ event, data }); },
    close() { onClose?.(); },
  };
};
const setup = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banda-executor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const record = auth.verify(auth.create({ name: 'runtime', role: 'agent' }).token);
  const connect = (identity = record) => hub.bind(client(), identity, '127.0.0.1');
  const executor = connect();
  const registration = { name: 'Alex', room: 'dev', executorId: 'machine-1', runId: 'run-1' };
  hub.register(executor, registration);
  return { dir, auth, hub, connect, executor, registration, owner: connect(owner) };
};

test('managed member has one executor; observers preserve state and cannot execute', async (t) => {
  const { hub, connect, executor, registration, owner } = setup(t);
  hub.setStatus(executor, 'blocked', 'approval required');
  const observer = connect();
  const before = hub.list(owner)[0];
  assert.deepEqual(hub.register(observer, { name: 'Alex', mode: 'observer', room: 'other' }), before);
  assert.throws(() => hub.register(connect(), registration), { code: 409 });
  assert.throws(() => hub.register(connect(), { name: 'Alex' }), { code: 409 });
  assert.throws(() => hub.setStatus(observer, 'waiting'), { code: 403 });
  const control = await hub.send(owner, 'Alex', '!cancel');
  assert.throws(() => hub.ack(observer, [control.id]), { code: 403 });
  assert.equal(hub.inboxFor(executor)[0].runId, 'run-1');
  assert.equal(observer.client.events.filter((e) => e.event === 'agents/message').length, 0);
  assert.equal(executor.client.events.find((e) => e.event === 'agents/message').data.id, control.id);
  const screen = hub.read(owner, 'Alex', 10);
  const request = executor.client.events.find((e) => e.event === 'agents/readRequest').data;
  assert.throws(() => hub.readReply(observer, request.id, 'forged screen'), { code: 403 });
  hub.readReply(executor, request.id, 'actual runtime screen');
  assert.deepEqual(await screen, { name: 'Alex', text: 'actual runtime screen' });
});

test('MCP observer cannot keep disconnected executor online or receive offline controls', async (t) => {
  const { hub, connect, executor, registration, owner } = setup(t);
  const observer = connect();
  hub.register(observer, { name: 'Alex', mode: 'observer' });
  executor.client.close();
  assert.equal(hub.list(owner)[0].connected, false);
  assert.equal(hub.list(owner)[0].status, 'stopped');
  const queued = await hub.send(owner, 'Alex', '!stop');
  assert.equal(queued.delivered, false);
  assert.equal(queued.queued, true);
  assert.equal(hub.inboxFor(observer)[0].runId, 'run-1');
  const next = connect();
  hub.register(next, { ...registration, runId: 'run-2' });
  observer.client.close();
  assert.equal(hub.list(owner)[0].connected, true);
  const fresh = await hub.send(owner, 'Alex', '!cancel');
  assert.deepEqual(hub.inboxFor(next).map(({ id, runId }) => ({ id, runId })), [
    { id: queued.id, runId: 'run-1' }, { id: fresh.id, runId: 'run-2' },
  ]);
});

test('managed run identity survives hub restart and cannot silently become a legacy member', async (t) => {
  const { dir, auth, hub, owner, registration } = setup(t);
  const sent = await hub.send(owner, 'Alex', 'finish the current task');
  const restored = new Hub({ dataDir: dir, auth, console: quiet });
  const member = restored.members.get('Alex');
  assert.equal(member.runId, 'run-1');
  assert.equal(member.connected, false);
  const fresh = restored.bind(client(), owner.record, '127.0.0.1');
  assert.throws(() => restored.register(fresh, { name: 'Alex' }), { code: 409 });
  restored.register(fresh, { ...registration, runId: 'run-2' });
  assert.equal(restored.inboxFor(fresh).find((m) => m.id === sent.id).runId, 'run-1');
  assert.equal('executorId' in restored.publicMember(member), false);
});

test('unknown is not ready, is excluded from routing, and changed reasons are published', async (t) => {
  const { hub, owner, executor } = setup(t);
  hub.setStatus(executor, 'unknown', 'no reliable lifecycle signal');
  assert.equal(heuristic('Alex review this', hub.list(owner)), null);
  const waiting = hub.wait(owner, 'Alex', ['waiting'], 1000);
  let ready = false;
  waiting.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  const count = owner.client.events.filter((e) => e.event === 'agents/changed').length;
  hub.setStatus(executor, 'unknown', 'delivery outcome uncertain');
  assert.equal(owner.client.events.filter((e) => e.event === 'agents/changed').length, count + 1);
  hub.setStatus(executor, 'waiting');
  assert.equal((await waiting).status, 'waiting');
});

test('legacy runtime cannot be adopted while a second legacy writer remains', (t) => {
  const { hub, connect } = setup(t);
  const one = connect();
  const two = connect();
  hub.register(one, { name: 'Legacy' });
  hub.register(two, { name: 'Legacy' });
  assert.throws(() => hub.register(one, { name: 'Legacy', executorId: 'machine', runId: 'run' }), { code: 409 });
  two.client.close();
  hub.register(one, { name: 'Legacy', executorId: 'machine', runId: 'run' });
  assert.throws(() => hub.register(connect(), { name: 'Missing', mode: 'observer' }), { code: 404 });
});

test('observer of a legacy member does not become a phantom runtime', async (t) => {
  const { hub, connect, owner } = setup(t);
  const runtime = connect();
  hub.register(runtime, { name: 'LegacyObserved', room: 'dev' });
  const observer = connect();
  hub.register(observer, { name: 'LegacyObserved', mode: 'observer' });
  runtime.client.close();
  assert.equal(hub.list(owner).find((member) => member.name === 'LegacyObserved').connected, false);
  const result = await hub.send(owner, 'LegacyObserved', 'work after reconnect');
  assert.equal(result.delivered, false);
  assert.equal(result.queued, true);
  assert.equal(observer.client.events.some(({ event }) => event === 'agents/message'), false);
  assert.throws(() => hub.read(owner, 'LegacyObserved'), { code: 409 });
});
