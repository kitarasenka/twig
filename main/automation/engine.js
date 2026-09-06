import { randomUUID } from 'node:crypto';
import { runGit } from '../git/exec.js';
import { evaluateConditions } from '../../renderer/src/features/automations/condition-eval.js';
import { canBlock, isKnownEvent } from '../../renderer/src/features/automations/event-labels.js';
import { commandsIn } from '../../renderer/src/features/automations/schema.js';
import { runAction } from './actions.js';
import { readRepoConfig } from './discovery.js';

const zsplit = text => text.split('\0').filter(Boolean);

/**
 * Assembles the context a pipeline sees. Built in main from Git itself so the
 * renderer can never misreport which branch, files or message an event applies
 * to. Only reads what the selected pipelines actually need.
 */
async function buildContext({ event, cwd, log, message, remote, operation, needsAddedLines }) {
  const head = await runGit({ argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, log, operation: 'Background: read current branch' });
  const branch = head.code === 0 && head.stdout.trim() && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : null;

  let changedFiles = [];
  if (event === 'pre-push') {
    const range = await runGit({ argv: ['diff', '--name-only', '-z', '@{upstream}..HEAD'], cwd, log, operation: 'Background: files being pushed' });
    changedFiles = range.code === 0 ? zsplit(range.stdout) : [];
  } else if (['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'].includes(event)) {
    const staged = await runGit({ argv: ['diff', '--cached', '--name-only', '-z'], cwd, log, operation: 'Background: staged files' });
    changedFiles = staged.code === 0 ? zsplit(staged.stdout) : [];
  } else {
    const worktree = await runGit({ argv: ['diff', '--name-only', '-z', 'HEAD'], cwd, log, operation: 'Background: changed files' });
    changedFiles = worktree.code === 0 ? zsplit(worktree.stdout) : [];
  }

  let addedLines = [];
  if (needsAddedLines) {
    const args = event === 'pre-push'
      ? ['diff', '--unified=0', '--no-color', '@{upstream}..HEAD']
      : ['diff', '--cached', '--unified=0', '--no-color'];
    const patch = await runGit({ argv: args, cwd, log, operation: 'Background: read added lines' });
    if (patch.code === 0) addedLines = collectAddedLines(patch.stdout);
  }

  return { branch, remote: remote ?? null, changedFiles, addedLines, commitMessage: message ?? null, operation };
}

/** Groups the `+` lines of a unified diff (unified=0) by file. */
export function collectAddedLines(patch) {
  const files = new Map();
  let current = null;
  for (const line of patch.split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.*)$/);
    if (header) { current = header[1]; files.set(current, files.get(current) || []); continue; }
    if (current && line.startsWith('+') && !line.startsWith('+++')) files.get(current).push(line.slice(1));
  }
  return [...files].map(([file, lines]) => ({ file, text: lines.join('\n') }));
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
  const basePath = loginPath || process.env.PATH || '';
  const env = { PATH: [...settings.extraPath, basePath].filter(Boolean).join(process.platform === 'win32' ? ';' : ':') };

  const steps = [];
  let blocked = false;
  const startedAt = new Date().toISOString();
  const started = performance.now();

  for (const pipeline of pipelines) {
    if (!evaluateConditions(pipeline.conditions, context)) continue;
    for (const action of pipeline.actions) {
      if (!evaluateConditions(action.conditions, context)) {
        const skipped = { pipeline: pipeline.name, name: action.name || action.type, type: action.type, status: 'skipped', detail: 'Conditions not met.', command: describe(action) };
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
