'use strict';

const fs = require('node:fs');
const path = require('node:path');

/// Which build is running. A chat keeps the code it started with, so "did the update land?"
/// is a real question: this answers it from the files, without spawning git.
const head = (gitDir) => {
  const text = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  if (!text.startsWith('ref: ')) return text;
  const ref = text.slice(5).trim();
  try {
    return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
  } catch {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : '';
  }
};

const build = (root = path.join(__dirname, '..')) => {
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '';
  } catch {
    version = '';
  }
  let commit = '';
  // the cli may be a folder inside the repository, so look a couple of levels up for .git
  for (let dir = root, i = 0; i < 4 && dir !== path.dirname(dir); dir = path.dirname(dir), i++) {
    const gitDir = path.join(dir, '.git');
    if (!fs.existsSync(gitDir)) continue;
    try {
      commit = head(fs.statSync(gitDir).isDirectory() ? gitDir : path.join(dir, fs.readFileSync(gitDir, 'utf8').trim().replace(/^gitdir:\s*/, ''))).slice(0, 7);
    } catch {
      commit = '';
    }
    break;
  }
  return { version, commit, label: commit ? `${version} ${commit}` : version };
};

module.exports = { build };
