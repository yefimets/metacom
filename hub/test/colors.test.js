'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { pick, assignAll, legacy, COLORS } = require('../lib/colors.js');

const member = (name, room, kind = 'agent', extra = {}) => ({ name, room, kind, ...extra });

test('colors: nobody in a room shares one, and a person\'s is theirs in every room', () => {
  const all = [
    member('misha', 'opn', 'human', { connected: true }),
    member('probe', 'dev', 'human', { lastSeen: '2020-01-01T00:00:00Z' }), // a test name from long ago holds nothing
    ...Array.from({ length: 12 }, (_, i) => member(`dev${i}`, 'dev')),
    ...Array.from({ length: 6 }, (_, i) => member(`opn${i}`, 'opn')),
  ];
  assignAll(all);
  for (const room of ['dev', 'opn']) {
    const here = all.filter((m) => m.room === room).map((m) => m.color);
    assert.strictEqual(new Set(here).size, here.length, `${room}: every name its own colour`);
  }
  const misha = all.find((m) => m.name === 'misha').color;
  assert.ok(all.every((m) => m.name === 'misha' || m.color !== misha), 'no agent anywhere takes a human\'s colour');
  assert.ok(all.every((m) => m.color >= 0 && m.color < COLORS));
});

test('colors: a name keeps the colour it always had when it is free', () => {
  const all = [member('misha', 'opn', 'human'), member('cfo', 'opn')];
  assignAll(all);
  assert.strictEqual(all[0].color, legacy('misha'), 'misha stays the colour misha always was');
});

test('colors: one that is taken moves, and a colour once given is kept', () => {
  const misha = member('misha', 'opn', 'human', { color: 2 });
  const clash = member('newbie', 'opn', 'agent', { color: 2 });
  assert.notStrictEqual(pick(clash, [misha, clash]), 2, 'misha\'s green is not shared');
  const kept = member('opendev', 'opn', 'agent', { color: 7 });
  assert.strictEqual(pick(kept, [misha, kept]), 7, 'nothing moves without a reason');
});
