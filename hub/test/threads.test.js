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
  const misha = hub.bind(fakeClient(), owner, '127.0.0.1');
  hub.register(misha, { name: 'misha', room: 'dev', kind: 'human' });
  const agent = (name) => {
    const client = fakeClient();
    const conn = hub.bind(client, auth.verify(auth.create({ name: `t-${name}`, role: 'agent' }).token), '127.0.0.1');
    hub.register(conn, { name, room: 'dev', accept: 'any' });
    hub.setStatus(conn, 'waiting');
    return { conn, client };
  };
  return { hub, misha, agent };
};

test('threads: a plain command starts a thread; a reply to anything in it continues it', async () => {
  const { hub, misha, agent } = setup();
  const dev = agent('metadev');
  const first = await hub.send(misha, 'metadev', 'fix the login bug');
  const got = dev.client.events.filter(([n]) => n === 'agents/message').map(([, m]) => m);
  assert.strictEqual(got[0].thread, first.id, 'a new thread, named after its first message');
  assert.strictEqual(got[0].replyTo, null);
  // the agent answers in the room: that joins the thread and answers the command
  const answer = hub.say(dev.conn, 'dev', 'fixed, PR #3');
  assert.strictEqual(answer.thread, first.id);
  assert.strictEqual(answer.replyTo, first.id);
  // misha replies to the answer: same thread
  const more = await hub.send(misha, 'metadev', 'also add a test', 'command', null, null, answer.id);
  const m2 = dev.client.events.filter(([n]) => n === 'agents/message').map(([, m]) => m)[1];
  assert.strictEqual(m2.thread, first.id);
  assert.strictEqual(m2.replyTo, answer.id);
  assert.ok(more.id);
  // a plain mention again: a new thread
  const fresh = await hub.send(misha, 'metadev', 'now look at the docs');
  const m3 = dev.client.events.filter(([n]) => n === 'agents/message').map(([, m]) => m)[2];
  assert.strictEqual(m3.thread, fresh.id);
  assert.strictEqual(hub.list(misha).find((m) => m.name === 'metadev').thread, fresh.id, '/agents shows the thread it works in');
});

test('threads: a command an agent gives another agent is new work, a note back stays in its thread', async () => {
  const { hub, misha, agent } = setup();
  const ceo = agent('metaceo');
  const dev = agent('metadev');
  const task = await hub.send(misha, 'metaceo', 'ship the release');
  // metaceo delegates: that is a new thread for metadev, not misha's
  const delegated = await hub.send(ceo.conn, 'metadev', 'run the tests');
  const toDev = dev.client.events.filter(([n]) => n === 'agents/message').map(([, m]) => m)[0];
  assert.strictEqual(toDev.thread, delegated.id);
  assert.notStrictEqual(toDev.thread, task.id);
  // metaceo reports back to misha as a note: in misha's thread
  await hub.send(ceo.conn, 'misha', 'released', 'info');
  const report = hub.store.tailRoom('dev', 10).find((m) => m.text === 'released');
  assert.strictEqual(report.thread, task.id);
  assert.strictEqual(report.replyTo, task.id);
});

test('threads: an agent may reply with the short #id hub_read shows', async () => {
  const { hub, misha, agent } = setup();
  const ceo = agent('metaceo');
  agent('metadev');
  const task = await hub.send(misha, 'metaceo', 'ship it');
  const r = await hub.send(ceo.conn, 'metadev', 'carry on with that', 'command', null, null, `#${task.id.slice(0, 8)}`);
  const msg = hub.store.tailRoom('dev', 5).find((m) => m.id === r.id);
  assert.strictEqual(msg.replyTo, task.id, 'the short id is found');
  assert.strictEqual(msg.thread, task.id);
});

test('threads: a reply to a message the hub no longer remembers still names a thread', async () => {
  const { hub, misha, agent } = setup();
  agent('metadev');
  const r = await hub.send(misha, 'metadev', 'carry on', 'command', null, null, 'old-message-id');
  const msg = hub.store.tailRoom('dev', 5).find((m) => m.id === r.id);
  assert.strictEqual(msg.thread, 'old-message-id');
});
