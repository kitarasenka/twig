import path from 'node:path';
import { runStep } from './exec.js';
import { parseCommand, isBareExecutable } from '../../renderer/src/features/automations/command-parse.js';
import { matchesGlob } from '../../renderer/src/features/automations/condition-eval.js';
import { checkMessage } from '../../renderer/src/features/automations/message-rules.js';
import { scanText } from '../../renderer/src/features/automations/secret-rules.js';

/**
 * Runs one action and returns a step result:
 *   { status: 'passed' | 'failed', detail, stdout, stderr, ms, findings? }
 *
 * Only `command`, `custom` and `script` start a process, and they go through
 * `runStep` (spawn, no shell). The rest are pure checks over the context main
 * assembled for the event.
 */
export async function runAction({ action, context, cwd, log, env, signal, timeoutMs }) {
  switch (action.type) {
    case 'command':
    case 'custom': {
      const argv = parseCommand(action.command);
      if (!isBareExecutable(argv[0])) {
        return { status: 'failed', detail: `"${argv[0]}" is not a plain program name. Use "Run script" for a file in the repository.` };
      }
      return processResult(await runStep({ argv, cwd, log, env, signal, timeoutMs, operation: `Automation: ${action.name || action.command}` }));
    }

    case 'script': {
      const resolved = path.resolve(cwd, action.path);
      const relative = path.relative(cwd, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
        return { status: 'failed', detail: 'The script path is outside the repository.' };
      }
      const extra = action.args ? parseCommand(`x ${action.args}`).slice(1) : [];
      return processResult(await runStep({ argv: [resolved, ...extra], cwd, log, env, signal, timeoutMs, operation: `Automation: ${action.name || action.path}` }));
    }

    case 'validateMessage': {
      const { ok, detail } = checkMessage(action.rule, context.commitMessage ?? '');
      return { status: ok ? 'passed' : 'failed', detail: ok ? null : detail };
    }

    case 'checkBranch': {
      const branch = context.branch;
      const hit = branch != null && (action.block || []).some(pattern => matchesGlob(branch, pattern));
      return hit
        ? { status: 'failed', detail: `Direct commits to ${branch} are blocked by this pipeline.` }
        : { status: 'passed', detail: null };
    }

    case 'checkChangedFiles': {
      const files = context.changedFiles || [];
      const missing = (action.require || []).filter(glob => !files.some(file => matchesGlob(file, glob)));
      const present = (action.forbid || []).filter(glob => files.some(file => matchesGlob(file, glob)));
      if (missing.length) return { status: 'failed', detail: `Expected a change matching ${missing.join(', ')}.` };
      if (present.length) return { status: 'failed', detail: `Changes matching ${present.join(', ')} are not allowed here.` };
      return { status: 'passed', detail: null };
    }

    case 'secretScan': {
      const findings = [];
      for (const { file, text } of context.addedLines || []) findings.push(...scanText(text, file));
      return findings.length
        ? { status: 'failed', detail: `${findings.length} possible secret${findings.length === 1 ? '' : 's'} in the staged changes.`, findings }
        : { status: 'passed', detail: null, findings: [] };
    }

    default:
      return { status: 'failed', detail: `Unknown action type "${action.type}".` };
  }
}

function processResult(result) {
  const status = result.code === 0 && !result.timedOut && !result.cancelled ? 'passed' : 'failed';
  const detail = result.cancelled ? 'Cancelled.'
    : result.timedOut ? 'Timed out.'
      : result.code === 0 ? null
        : /ENOENT/.test(result.stderr) ? 'Command not found on PATH.'
          : `Exited with code ${result.code}.`;
  return { status, detail, stdout: result.stdout, stderr: result.stderr, ms: result.ms, cancelled: result.cancelled };
}
