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
  return { events: [], source: '127.0.0.1', on(name, fn) { handlers[name] = fn; }, emit(name, data) { if (name === 'close') return handlers.close?.(); this.events.push([name, data]); }, close() { handlers.close?.(); } };
};

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const auth = new Auth(dir, quiet);
  const hub = new Hub({ dataDir: dir, auth, console: quiet });
  const owner = auth.verify(fs.readFileSync(path.join(dir, 'bootstrap-token.txt'), 'utf8').trim());
  const human = (name, room) => {
    const client = fakeClient();
    const conn = hub.bind(client, owner, '127.0.0.1');
    hub.register(conn, { name, room, kind: 'human' });
    hub.join(conn, room);
    return { client, conn };
  };
  return { hub, auth, human };
};

const frame = Buffer.alloc(3200).toString('base64');
const events = (client, name) => client.events.filter(([n]) => n === name).map(([, d]) => d);

test('voice: join with the mic on, the room sees the roster', () => {
  const { hub, human } = setup();
  const misha = human('misha', 'dev');
  const bob = human('bob', 'dev');
  const state = hub.voice.join(misha.conn, 'dev');
  assert.deepStrictEqual(state.participants.map((p) => [p.name, p.mic, p.speaking]), [['misha', true, false]]);
  assert.strictEqual(events(bob.client, 'voice/changed').at(-1).participants[0].name, 'misha');
});

test('voice: frames reach the others in the call, not the sender, and mark the speaker', () => {
  const { hub, human } = setup();
  const misha = human('misha', 'dev');
  const bob = human('bob', 'dev');
  const eve = human('eve', 'dev');
  hub.voice.join(misha.conn, 'dev');
  hub.voice.join(bob.conn, 'dev');
  assert.deepStrictEqual(hub.voice.frame(misha.conn, frame), { ok: true });
  assert.strictEqual(events(bob.client, 'voice/frame').length, 1);
  assert.strictEqual(events(bob.client, 'voice/frame')[0].from, 'misha');
  assert.strictEqual(events(misha.client, 'voice/frame').length, 0);
  assert.strictEqual(events(eve.client, 'voice/frame').length, 0, 'not in the call: no audio');
  const roster = events(eve.client, 'voice/changed').at(-1).participants;
  assert.strictEqual(roster.find((p) => p.name === 'misha').speaking, true, 'the room sees who talks');
  hub.voice.quiet('dev', 'misha');
  assert.strictEqual(hub.voice.state('dev').participants.find((p) => p.name === 'misha').speaking, false);
});

test('voice: a muted mic sends nothing, and leaving or disconnecting drops you', () => {
  const { hub, human } = setup();
  const misha = human('misha', 'dev');
  const bob = human('bob', 'dev');
  hub.voice.join(misha.conn, 'dev');
  hub.voice.join(bob.conn, 'dev');
  hub.voice.mic(misha.conn, false);
  assert.deepStrictEqual(hub.voice.frame(misha.conn, frame), { ok: false });
  assert.strictEqual(events(bob.client, 'voice/frame').length, 0);
  assert.strictEqual(hub.voice.state('dev').participants.find((p) => p.name === 'misha').mic, false);
  hub.voice.leave(misha.conn);
  assert.deepStrictEqual(hub.voice.state('dev').participants.map((p) => p.name), ['bob']);
  bob.client.close();
  assert.deepStrictEqual(hub.voice.state('dev').participants, []);
  assert.deepStrictEqual(hub.voice.calls(), []);
});

test('voice: agents join only their own room, bad frames are refused, frames have a budget', () => {
  const { hub, auth, human } = setup();
  const misha = human('misha', 'dev');
  const tok = auth.create({ name: 'a', role: 'agent' });
  const conn = hub.bind(fakeClient(), auth.verify(tok.token), '127.0.0.1');
  hub.register(conn, { name: 'Alex', room: 'dev' });
  assert.throws(() => hub.voice.join(conn, 'ops'), (e) => e.code === 403);
  hub.voice.join(misha.conn, 'dev');
  assert.throws(() => hub.voice.frame(misha.conn, 'x'.repeat(100_000)), (e) => e.code === 400);
  assert.throws(() => {
    for (let i = 0; i < 100; i++) hub.voice.frame(misha.conn, frame);
  }, (e) => e.code === 429);
  hub.voice.quiet('dev', 'misha', false);
});
