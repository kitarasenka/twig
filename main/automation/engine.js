import { randomUUID } from 'node:crypto';
import { runGit } from '../git/exec.js';
import { parseNumstat } from '../git/numstat.js';
import { redactCredentials } from '../git/redact.js';
import { evaluateConditions } from '../../renderer/src/features/automations/condition-eval.js';
import { canBlock, isKnownEvent } from '../../renderer/src/features/automations/event-labels.js';
import { commandsIn } from '../../renderer/src/features/automations/schema.js';
import { runAction } from './actions.js';
import { readRepoConfig } from './discovery.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

const zsplit = text => text.split('\0').filter(Boolean);

/** More added text than this in one scan is not read: the step fails and says so. */
export const SCAN_BYTES = 64 * 1024 * 1024;

// A person's diff settings must not decide what a scan sees: prefixes off or
// mnemonic, an external diff tool, `-diff` in .gitattributes, a textconv, a
// submodule printed as a log.
const SCAN_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--find-renames', '--submodule=short'];

/**
 * What a push is about to send is measured from: the upstream, or for a branch
 * without one the point it left the main line, or the empty tree when nothing
 * on the remote relates to it. Everything is read with exit code 0.
 */
async function pushBase({ cwd, log, branch, remote }) {
  const label = 'Background: find what a push sends';
  const read = argv => runGit({ argv, cwd, log, operation: label });
  if (branch) {
    const own = await read(['for-each-ref', '--format=%(upstream)%00%(upstream:track)', `refs/heads/${branch}`]);
    const [upstream, track] = own.stdout.trim().split('\0');
    if (own.code === 0 && upstream && track !== '[gone]') return '@{upstream}';
  }
  const prefix = `refs/remotes/${remote || 'origin'}`;
  const lines = [`${prefix}/HEAD`, `${prefix}/main`, `${prefix}/master`, 'refs/heads/main', 'refs/heads/master'];
  const found = await read(['for-each-ref', '--format=%(refname)', ...lines]);
  const present = new Set(found.code === 0 ? found.stdout.split('\n') : []);
  const line = lines.find(name => present.has(name) && name !== `refs/heads/${branch}`);
  const fork = line ? await read(['merge-base', 'HEAD', line]) : null;
  if (fork?.code === 0) return fork.stdout.trim();
  return (await runGit({ argv: ['hash-object', '-t', 'tree', '--stdin'], stdin: '', cwd, log, operation: label })).stdout.trim();
}

/**
 * The added lines of `selection`, with the patch and the line counts read
 * apart: a file Git counts added lines in and the patch gave none for means the
 * reading failed, and a scan that read nothing must not answer "passed". The
 * patch stays out of the journal: it is bytes in, bytes counted.
 */
async function readAddedLines({ cwd, log, selection }) {
  const operation = 'Background: read added lines';
  const patch = await runGit({ argv: ['-c', 'core.quotePath=false', 'diff', ...selection, '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', ...SCAN_ARGS],
    cwd, log, operation, binary: true, maxBytes: SCAN_BYTES });
  if (patch.truncated) return { addedLines: [], scanProblem: ui`These changes are over ${SCAN_BYTES / 1024 / 1024} MB, too large to scan for secrets.` };
  const counts = await runGit({ argv: ['diff', ...selection, '--numstat', '-z', ...SCAN_ARGS], cwd, log, operation: 'Background: count added lines' });
  if (patch.code !== 0 || counts.code !== 0) return { addedLines: [], scanProblem: ui`Git could not read the changes, so nothing was scanned.` };
  const addedLines = collectAddedLines(patch.stdout.toString('utf8'));
  const read = new Set(addedLines.map(entry => entry.file));
  const missed = [...parseNumstat(counts.stdout).values()].filter(count => (count.binary || count.insertions > 0) && !read.has(count.path)).map(count => count.path);
  return { addedLines, scanProblem: missed.length ? ui`Could not read ${missed.join(', ')}, so it was not scanned.` : null };
}

/**
 * Assembles the context a pipeline sees. Built in main from Git itself so the
 * renderer can never misreport which branch, files or message an event applies
 * to. Only reads what the selected pipelines actually need.
 */
async function buildContext({ event, cwd, log, message, remote, operation, needsAddedLines }) {
  const head = await runGit({ argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, log, operation: 'Background: read current branch' });
  const branch = head.code === 0 && head.stdout.trim() && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : null;

  let changedFiles = [];
  let selection = ['--cached'];
  if (event === 'pre-push') {
    selection = [await pushBase({ cwd, log, branch, remote }), 'HEAD'];
    const range = await runGit({ argv: ['diff', '--name-only', '-z', ...selection], cwd, log, operation: 'Background: files being pushed' });
    changedFiles = range.code === 0 ? zsplit(range.stdout) : [];
  } else if (['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'].includes(event)) {
    const staged = await runGit({ argv: ['diff', '--cached', '--name-only', '-z'], cwd, log, operation: 'Background: staged files' });
    changedFiles = staged.code === 0 ? zsplit(staged.stdout) : [];
  } else {
    const worktree = await runGit({ argv: ['diff', '--name-only', '-z', 'HEAD'], cwd, log, operation: 'Background: changed files' });
    changedFiles = worktree.code === 0 ? zsplit(worktree.stdout) : [];
  }

  const added = needsAddedLines ? await readAddedLines({ cwd, log, selection }) : { addedLines: [], scanProblem: null };
  return { branch, remote: remote ?? null, changedFiles, ...added, commitMessage: message ?? null, operation };
}

const ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };

/** A path as `+++` prints it: `"b/a\\tb"`, C-quoted with octal bytes, or plain with a tab after a name holding spaces. */
function patchPath(field) {
  if (!field.startsWith('"')) return field.replace(/\t$/, '').replace(/^b\//, '');
  const bytes = [];
  for (let at = 1; at < field.length - 1; at++) {
    if (field[at] !== '\\') { bytes.push(...Buffer.from(field[at], 'utf8')); continue; }
    const octal = /^[0-7]{3}/.exec(field.slice(at + 1));
    if (octal) { bytes.push(Number.parseInt(octal[0], 8)); at += 3; } else bytes.push(ESCAPES[field[++at]] ?? 0);
  }
  return Buffer.from(bytes).toString('utf8').replace(/^b\//, '');
}

/**
 * Groups the `+` lines of a unified diff by file. Hunks are counted, not
 * guessed at: an added line that reads `++ b/x` prints as `+++ b/x`, and
 * taking it for a header would drop it from the scan.
 */
export function collectAddedLines(patch) {
  const files = new Map();
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line[0] === '+') { newLeft--; files.get(current)?.push(line.slice(1)); }
      else if (line[0] === '-') oldLeft--;
      else if (line[0] === ' ') { oldLeft--; newLeft--; }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) { oldLeft = Number(hunk[1] ?? 1); newLeft = Number(hunk[2] ?? 1); continue; }
    if (line.startsWith('diff --git ')) current = null;
    else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) {
      current = patchPath(line.slice(4));
      files.set(current, files.get(current) || []);
    }
  }
  return [...files].map(([file, lines]) => ({ file, text: lines.join('\n') }));
}

/** A blocked or failed run in a line or two a person or an agent can act on. */
export function stepReason(steps) {
  const failed = steps.filter(step => step.status === 'failed');
  return failed.map(step => {
    const output = redactCredentials(`${step.stderr || ''}\n${step.stdout || ''}`).split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-6).join('\n').slice(-600);
    return `${step.pipeline ? `${step.pipeline} → ` : ''}${step.name}: ${step.detail || 'failed'}${output ? `\n${output}` : ''}`;
  }).join('\n') || 'an automation blocked it';
}

/**
 * Which pipelines run for this event: the local ones the user built in Twig
 * (trusted by construction), plus repository pipelines only when the trust
 * record still matches the file on disk and every command in them was approved.
 */
export async function selectPipelines({ event, cwd, localConfig, trust }) {
  const local = localConfig.pipelines.filter(p => p.event === event && p.enabled);
  const repo = await readRepoConfig(cwd);
  let repoPipelines = [];
  if (repo.config && repo.digest && repo.digest === trust.digest) {
    const approved = new Set(trust.approvedCommands || []);
    const enabled = new Set(trust.enabledRepoPipelineIds || []);
    repoPipelines = repo.config.pipelines.filter(p =>
      p.event === event && p.enabled && enabled.has(p.id)
      && commandsIn({ pipelines: [p] }).every(command => approved.has(command)));
  }
  return { pipelines: [...local, ...repoPipelines], repo };
}

/**
 * Fires every pipeline bound to `event`. Returns
 *   { ok, blocked, executionId, steps, ran }
 * `blocked` is only ever true for a pre-* event whose pipeline is set to block.
 */
export async function triggerPipeline({ event, repoId, cwd, log, automations, runs, loginPath = null, message = null, remote = null, operation = event, signal = null, onStep = null }) {
  if (!isKnownEvent(event)) throw new TypeError(`Unknown hook event "${event}".`);
  const settings = automations.config(repoId).settings;
  const localConfig = automations.config(repoId);
  const trust = automations.trust(repoId);
  const executionId = randomUUID();

  if (settings.enabled === false) {
    return { ok: true, blocked: false, executionId, steps: [], ran: false };
  }

  const { pipelines } = await selectPipelines({ event, cwd, localConfig, trust });
  if (pipelines.length === 0) return { ok: true, blocked: false, executionId, steps: [], ran: false };

  const needsAddedLines = pipelines.some(p => p.actions.some(a => a.type === 'secretScan'));
  const context = await buildContext({ event, cwd, log, message, remote, operation, needsAddedLines });
  // Steps see the login-shell PATH (GUI Electron inherits a stub one) plus any
  // extra entries configured in Settings.
  const basePath = (await loginPath) || process.env.PATH || ''; // a promise while the login shell answers
  const env = { PATH: [...settings.extraPath, basePath].filter(Boolean).join(process.platform === 'win32' ? ';' : ':') };

  const steps = [];
  let blocked = false;
  const startedAt = new Date().toISOString();
  const started = performance.now();

  for (const pipeline of pipelines) {
    if (!evaluateConditions(pipeline.conditions, context)) continue;
    for (const action of pipeline.actions) {
      if (!evaluateConditions(action.conditions, context)) {
        const skipped = { pipeline: pipeline.name, name: action.name || action.type, type: action.type, status: 'skipped', detail: ui`Conditions not met.`, command: describe(action) };
        steps.push(skipped); onStep?.(skipped);
        continue;
      }
      const running = { pipeline: pipeline.name, name: action.name || action.type, type: action.type, status: 'running', command: describe(action) };
      onStep?.(running);
      let outcome;
      try {
        outcome = await runAction({ action, context, cwd, log, env, signal, timeoutMs: settings.timeoutMs });
      } catch (error) {
        outcome = { status: 'failed', detail: error.message };
      }
      const step = { ...running, ...outcome };
      steps.push(step); onStep?.(step);
      if (step.status === 'failed' && !action.continueOnError) {
        if (canBlock(event) && pipeline.onFailure === 'block') blocked = true;
        break;
      }
    }
    if (blocked) break;
  }

  const failed = steps.some(step => step.status === 'failed');
  const execution = {
    id: executionId, event, operation, startedAt, ms: Math.round(performance.now() - started),
    result: blocked ? 'blocked' : failed ? 'failed' : 'passed', bypassed: false, steps
  };
  if (steps.length) await runs.append(repoId, execution);
  return { ok: !failed, blocked, executionId, steps, ran: steps.length > 0 };
}

function describe(action) {
  if (action.type === 'command' || action.type === 'custom') return action.command;
  if (action.type === 'script') return `${action.path} ${action.args}`.trim();
  if (action.type === 'validateMessage') return `message: ${action.rule?.mode || 'rule'}`;
  if (action.type === 'checkBranch') return `block branch: ${(action.block || []).join(', ')}`;
  if (action.type === 'checkChangedFiles') return `changed files rule`;
  if (action.type === 'secretScan') return 'scan staged changes for secrets';
  return action.type;
}
