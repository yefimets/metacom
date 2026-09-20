'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

/// The terminal chat is an Ink app in src/chat (TypeScript, termcn components), loaded through
/// tsx so nothing needs building. Pipes and --plain get the bare readline chat instead.
const chat = async ({ name, room, config, plain = false, theme = null }) => {
  if (plain || !process.stdin.isTTY || !process.stdout.isTTY) {
    const { plainChat } = require('./chat-plain.js');
    return plainChat({ name, room, config });
  }
  const { register } = require('tsx/esm/api');
  register({ tsconfig: path.join(__dirname, '..', 'tsconfig.json') });
  const { start } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'chat', 'main.tsx')).href);
  await start({ name, room, config, theme });
};

module.exports = { chat };
