'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Audio, Shaper, tools, rms, mix, FRAME_BYTES } = require('../lib/voice.js');

const fakeSpawner = () => {
  const spawned = [];
  const spawner = (cmd, args) => {
    const child = new EventEmitter();
    child.cmd = cmd;
    child.args = args;
    child.stderr = new PassThrough();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.written = [];
    child.stdin.on('data', (b) => child.written.push(b));
    child.kill = () => child.emit('exit', null);
    spawned.push(child);
    return child;
  };
  return { spawned, spawner };
};

const tone = (amp, bytes = FRAME_BYTES) => {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) b.writeInt16LE(i % 4 ? amp : -amp, i);
  return b;
};

test('voice: tools picks the first recorder and player found, env overrides win', () => {
  const found = tools({}, (cmd) => cmd === 'rec' || cmd === 'pacat');
  assert.strictEqual(found.rec[0], 'rec');
  assert.strictEqual(found.play[0], 'pacat');
  assert.strictEqual(tools({}, () => false).rec, null);
  assert.deepStrictEqual(tools({ MC_VOICE_PLAY: 'my-player' }, () => false).play, ['sh', ['-c', 'my-player']]);
});

test('voice: rms and mix', () => {
  assert.strictEqual(Math.round(rms(tone(1000))), 1000);
  const out = mix([tone(30000, 8), tone(30000, 8)], 8);
  assert.strictEqual(out.readInt16LE(0), -32768, 'clipped, not wrapped');
  assert.strictEqual(mix([tone(5, 4)], 8).readInt16LE(4), 0, 'a short speaker is padded with silence');
});

test('voice: the mic sends only while the voice is up, with a pre-roll before and a tail after', () => {
  const sent = [];
  const { spawned, spawner } = fakeSpawner();
  const audio = new Audio({ send: (d) => sent.push(d), tools: { rec: ['rec', []], play: null, hint: '' }, spawner, shape: { preroll: 2, hangover: 4 } });
  const states = [];
  audio.on('speaking', (on) => states.push(on));
  assert.strictEqual(audio.startMic(), true);
  const rec = spawned[0];
  rec.stdout.write(Buffer.concat([tone(10), tone(10), tone(10)]));
  assert.strictEqual(sent.length, 0, 'silence is not sent');
  rec.stdout.write(tone(2000).subarray(0, 100));
  rec.stdout.write(tone(2000).subarray(100));
  assert.strictEqual(sent.length, 3, 'the frames just before speech go too');
  for (let i = 0; i < 6; i++) rec.stdout.write(tone(10));
  assert.strictEqual(sent.length, 3 + 4, 'four frames of hangover');
  assert.deepStrictEqual(states, [true, false]);
  audio.close();
});

test('voice: quiet speech in a quiet room opens the gate and comes out levelled', () => {
  const s = new Shaper();
  for (let i = 0; i < 20; i++) s.push(tone(15)); // a quiet room
  const quiet = s.push(tone(250)); // a soft voice, well under the old fixed gate of 600
  assert.strictEqual(quiet.speaking, true);
  let out = null;
  for (let i = 0; i < 30; i++) out = s.push(tone(250)).frames.at(-1);
  assert.ok(rms(out) > 1500, `levelled up, got ${Math.round(rms(out))}`);
  const loud = s.push(tone(30000)).frames.at(-1);
  assert.ok(Math.abs(loud.readInt16LE(0)) <= 32767 && rms(loud) < 32767, 'a shout is limited, not wrapped');
});

test('voice: steady noise raises the gate, so a fan does not hold the mic open', () => {
  const s = new Shaper({ hangover: 2 });
  let last = null;
  for (let i = 0; i < 400; i++) last = s.push(tone(200));
  assert.strictEqual(last.speaking, false, `gate ${Math.round(s.threshold)} over noise 200`);
  assert.strictEqual(s.push(tone(3000)).speaking, true);
});

test('voice: a speaker who falls far behind is cut back, not played late', () => {
  const { spawner } = fakeSpawner();
  const audio = new Audio({ send: () => {}, tools: { rec: null, play: ['play', []], hint: '' }, spawner });
  for (let i = 0; i < 30; i++) audio.play('bob', tone(100).toString('base64')); // 1.2 s arrives at once
  clearInterval(audio.timer);
  const q = audio.queues.get('bob');
  assert.ok(q.buf.length <= 16000 * 2 * 0.25, `queued ${q.buf.length} bytes`);
  audio.close();
});

test('voice: frames from two speakers are buffered, then mixed into one player', () => {
  const { spawned, spawner } = fakeSpawner();
  const audio = new Audio({ send: () => {}, tools: { rec: null, play: ['play', []], hint: '' }, spawner });
  const now = Date.now();
  audio.play('bob', tone(100).toString('base64'));
  audio.play('eve', tone(200).toString('base64'));
  clearInterval(audio.timer);
  assert.strictEqual(audio.tick(now), null, 'one frame is not enough to start on');
  audio.play('bob', tone(100).toString('base64'));
  audio.play('eve', tone(200).toString('base64'));
  const first = audio.tick(now + 1000);
  assert.ok(first && first.length > 0);
  assert.strictEqual(first.readInt16LE(0), -300, 'both voices in one sample');
  assert.strictEqual(spawned[0].cmd, 'play');
  assert.strictEqual(audio.tick(now + 1000), null, 'nothing more is due at the same instant');
  const later = audio.tick(now + 1100);
  assert.ok(later.length > 0);
  audio.close();
});

test('voice: a player that refuses the small buffer is retried with a larger one, quietly', () => {
  const { spawned, spawner } = fakeSpawner();
  const audio = new Audio({ send: () => {}, tools: { rec: null, play: ['play', ['-q', '--buffer', '1280', '-']], hint: '' }, spawner });
  const errors = [];
  audio.on('error', (e) => errors.push(e));
  audio.write(Buffer.alloc(640));
  spawned[0].emit('exit', 2); // CoreAudio says no at once
  audio.write(Buffer.alloc(640));
  assert.deepStrictEqual(spawned[1].args, ['-q', '--buffer', '4096', '-']);
  assert.strictEqual(audio.player, spawned[1]);
  assert.deepStrictEqual(errors, [], 'a fallback that works says nothing');
  audio.close();
});

test('voice: a player that never works says why once, then stays off', () => {
  const { spawned, spawner } = fakeSpawner();
  const audio = new Audio({ send: () => {}, tools: { rec: null, play: ['play', ['--buffer', '1280', '-']], hint: '' }, spawner });
  const errors = [];
  audio.on('error', (e) => errors.push(e));
  for (let i = 0; i < 20; i++) {
    audio.write(Buffer.alloc(640));
    const child = spawned.at(-1);
    child.stderr.write('play FAIL formats: can\'t open output file `default\': no device\n');
    if (audio.player === child) child.emit('exit', 1);
  }
  assert.strictEqual(spawned.length, 4, 'four variants, then no more');
  assert.deepStrictEqual(spawned.slice(0, 3).map((c) => c.args), [['--buffer', '1280', '-'], ['--buffer', '4096', '-'], ['-']]);
  assert.deepStrictEqual(spawned[3].args, ['-c', "cat | exec 'play' '-'"], 'last, a real pipe instead of a socket');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /speaker does not work \(tried 4 ways; the last: cat \| exec play - exited with code 1\) · play FAIL formats/);
  audio.close();
});

test('voice: no recorder is an error, not a crash', () => {
  const audio = new Audio({ send: () => {}, tools: { rec: null, play: null, hint: 'brew install sox' } });
  const errors = [];
  audio.on('error', (e) => errors.push(e));
  assert.strictEqual(audio.startMic(), false);
  assert.match(errors[0], /brew install sox/);
});
