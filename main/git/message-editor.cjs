#!/usr/bin/env node
// GIT_EDITOR. Git opens a commit message editor at points Twig cannot avoid:
// a `reword` step, the end of a squash chain, and every `--continue` of a
// merge, cherry-pick, revert or rebase. Without an editor of our own Git would
// fall back to vi and hang invisibly.
//
// Which commit is being written is read from the rebase's own `done` file
// rather than counted: Git calls the editor once per squash *chain*, not once
// per squash line, and a conflict adds an unplanned call at `--continue`. The
// last line of `done` names the step actually in progress, so a message keyed
// by object id lands on the right commit no matter how the run was
// interrupted. An id with no prepared message leaves the file untouched, which
// is precisely Git's own default text.
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  process.stderr.write('🌱 Twig was called as an editor without a file.\n');
  process.exit(1);
}

function currentStepId() {
  const gitDir = process.env.TWIG_GIT_DIR;
  if (!gitDir) return null;
  let done;
  try {
    done = fs.readFileSync(path.join(gitDir, 'rebase-merge', 'done'), 'utf8');
  } catch {
    return null;
  }
  const lines = done.split('\n').filter(line => line.trim().length > 0 && !line.startsWith('#'));
  const match = /^\S+\s+([0-9a-f]{40}|[0-9a-f]{64})\b/i.exec(lines.at(-1) || '');
  return match ? match[1].toLowerCase() : null;
}

const queuePath = process.env.TWIG_REBASE_MESSAGES;
if (!queuePath) process.exit(0);
const id = currentStepId();
if (!id) process.exit(0);
let messages;
try {
  messages = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
} catch {
  process.exit(0);
}
const message = messages && Object.hasOwn(messages, id) ? messages[id] : null;
if (typeof message !== 'string') process.exit(0);
try {
  fs.writeFileSync(target, message.endsWith('\n') ? message : `${message}\n`, 'utf8');
} catch (error) {
  process.stderr.write(`🌱 Twig could not write the commit message: ${error.message}\n`);
  process.exit(1);
}
