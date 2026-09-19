'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validate, schema } = require('../lib/tools.js');

test('tools: valid calls are typed and cleaned', () => {
  assert.deepStrictEqual(validate('switch_flow', { flow: '3', extra: 1 }).args, { flow: 3 });
  assert.deepStrictEqual(validate('message_agent', { agent: 'auto', text: 'go' }).args, { agent: 'auto', text: 'go' });
  assert.strictEqual(validate('message_agent', { agent: 'x', text: 'y' }).tool.where, 'hub');
  assert.strictEqual(validate('new_flow', null).error, undefined);
});

test('tools: anything else is refused', () => {
  assert.match(validate('run_shell', { cmd: 'rm -rf /' }).error, /unknown tool/);
  assert.match(validate('switch_flow', { flow: 12 }).error, /above 9/);
  assert.match(validate('focus', { direction: 'diagonal' }).error, /one of/);
  assert.match(validate('open_url', {}).error, /missing url/);
  assert.match(validate('press_key', { key: 'cmd+q' }).error, /one of/);
});

test('tools: schema is OpenAI function format', () => {
  const s = schema();
  assert.ok(s.length > 20);
  assert.strictEqual(s[0].type, 'function');
  assert.ok(s.every((t) => t.function.name && t.function.parameters.type === 'object'));
});
