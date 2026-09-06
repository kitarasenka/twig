import assert from 'node:assert/strict';
import { HOOK_EVENTS, canBlock, eventPhase, isKnownEvent } from '../../renderer/src/features/automations/event-labels.js';
import { parseCommand, isBareExecutable } from '../../renderer/src/features/automations/command-parse.js';
import { evaluateConditions, matchesGlob, globToRegExp } from '../../renderer/src/features/automations/condition-eval.js';
import { checkMessage } from '../../renderer/src/features/automations/message-rules.js';
import { normalizeConfig, normalizePipeline, validatePipeline, commandsIn } from '../../renderer/src/features/automations/schema.js';
import { TEMPLATES, buildTemplate } from '../../renderer/src/features/automations/templates.js';

// --- event labels ----------------------------------------------------------
assert.equal(HOOK_EVENTS.length, 10);
for (const event of HOOK_EVENTS) {
  assert.ok(event.hook && event.label && event.hint && ['pre', 'post'].includes(event.phase), `event ${event.hook} fully described`);
  assert.equal(canBlock(event.hook), event.phase === 'pre');
}
assert.equal(eventPhase('pre-commit'), 'pre');
assert.equal(canBlock('post-commit'), false);
assert.equal(isKnownEvent('nope'), false);

// --- command parsing ------------------------------------------------------
assert.deepEqual(parseCommand('npm run lint'), ['npm', 'run', 'lint']);
assert.deepEqual(parseCommand('  node   -e "console.log(1)" '), ['node', '-e', 'console.log(1)']);
assert.deepEqual(parseCommand("pnpm exec eslint 'src/**/*.ts'"), ['pnpm', 'exec', 'eslint', 'src/**/*.ts']);
assert.deepEqual(parseCommand('git commit -m a\\ b'), ['git', 'commit', '-m', 'a b']);
for (const bad of ['a && b', 'a || b', 'a | b', 'a; b', 'a > f', 'echo $HOME', 'a `id`', 'a\nb', 'a "unbalanced']) {
  assert.throws(() => parseCommand(bad), TypeError, `must reject: ${bad}`);
}
assert.throws(() => parseCommand(''), TypeError);
assert.ok(isBareExecutable('npm') && isBareExecutable('pnpm') && isBareExecutable('a.sh'));
assert.ok(!isBareExecutable('./x') && !isBareExecutable('/usr/bin/x') && !isBareExecutable('a b'));

// --- glob + conditions ---------------------------------------------------
assert.ok(matchesGlob('src/a/b.ts', 'src/**/*.ts'));
assert.ok(matchesGlob('a.ts', '**/*.ts'));
assert.ok(matchesGlob('package.json', 'package.json'));
assert.ok(!matchesGlob('src/a.tsx', 'src/*.ts'));
assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'));
const ctx = { branch: 'feature/x', remote: 'origin', changedFiles: ['src/a.ts', 'README.md'], commitMessage: 'feat: hi [skip-checks]' };
assert.equal(evaluateConditions([], ctx), true);
assert.equal(evaluateConditions([{ type: 'branch', pattern: 'feature/*' }], ctx), true);
assert.equal(evaluateConditions([{ type: 'branch', pattern: 'main' }], ctx), false);
assert.equal(evaluateConditions([{ type: 'branch', pattern: 'main', negate: true }], ctx), true);
assert.equal(evaluateConditions([{ type: 'changedFiles', glob: '**/*.ts' }], ctx), true);
assert.equal(evaluateConditions([{ type: 'changedFiles', glob: '**/*.py', mode: 'none' }], ctx), true);
assert.equal(evaluateConditions([{ type: 'remote', name: 'upstream' }], ctx), false);
assert.equal(evaluateConditions([{ type: 'messageContains', text: '[skip-checks]' }], ctx), true);
assert.equal(evaluateConditions([{ type: 'unknown-type' }], ctx), false);

// --- message rules -----------------------------------------------------
assert.ok(checkMessage({ mode: 'conventional' }, 'feat(scope): thing').ok);
assert.ok(checkMessage({ mode: 'conventional' }, 'fix!: thing').ok);
assert.ok(!checkMessage({ mode: 'conventional' }, 'just words').ok);
assert.ok(checkMessage({ mode: 'ticketPrefix', prefix: 'PROJ' }, 'PROJ-123: fix login').ok);
assert.ok(!checkMessage({ mode: 'ticketPrefix', prefix: 'PROJ' }, 'fix login').ok);
assert.ok(checkMessage({ mode: 'regex', pattern: '^(feat|fix): ' }, 'feat: x').ok);
assert.ok(!checkMessage({ mode: 'regex', pattern: '[' }, 'x').ok);
assert.ok(!checkMessage({ mode: 'conventional' }, '').ok);

// --- schema + templates ----------------------------------------------
const normalized = normalizePipeline({ event: 'bogus', actions: [{ type: 'command', command: 'npm test' }] });
assert.equal(normalized.event, 'pre-commit');
assert.equal(normalized.onFailure, 'block');
assert.ok(normalized.id && normalized.actions[0].id);
const cfg = normalizeConfig({ pipelines: [{ event: 'pre-push', actions: [{ type: 'command', command: 'npm test' }] }], settings: { timeoutMs: 5 } });
assert.equal(cfg.settings.timeoutMs, 1000, 'timeout clamped to a floor');
assert.deepEqual(commandsIn(cfg), ['npm test']);

assert.deepEqual(TEMPLATES.map(t => validatePipeline(t.build()).valid), TEMPLATES.map(() => true));
assert.equal(buildTemplate('protect-main').event, 'pre-commit');
assert.equal(buildTemplate('conventional-commits').event, 'commit-msg');
assert.equal(buildTemplate('does-not-exist'), null);

const bad = validatePipeline({ event: 'pre-commit', name: '', actions: [{ type: 'command', command: 'a && b' }] });
assert.ok(!bad.valid && bad.errors.some(e => /shell operators/.test(e)) && bad.errors.some(e => /name/.test(e)));
assert.ok(!validatePipeline({ event: 'pre-commit', name: 'x', actions: [{ type: 'script', path: '../escape.sh' }] }).valid);

console.log('Automation checks passed: events, command parsing, conditions, message rules, schema, templates.');
