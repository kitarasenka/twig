#!/usr/bin/env node
// GIT_SEQUENCE_EDITOR. Git runs this once at the start of an interactive
// rebase, handing it the path of the todo list it wants edited. Twig replaces
// that file with the plan the user approved in the rebase dialog, so the
// rebase runs exactly what was on screen and never falls back to a terminal
// editor. Failing loudly matters: exiting non-zero makes Git abort the rebase
// instead of silently running its own default todo.
const fs = require('node:fs');

const source = process.env.TWIG_REBASE_TODO;
const target = process.argv[2];
if (!source || !target) {
  process.stderr.write('🌱 Twig could not supply the rebase plan.\n');
  process.exit(1);
}
try {
  fs.writeFileSync(target, fs.readFileSync(source, 'utf8'), 'utf8');
} catch (error) {
  process.stderr.write(`🌱 Twig could not write the rebase plan: ${error.message}\n`);
  process.exit(1);
}
