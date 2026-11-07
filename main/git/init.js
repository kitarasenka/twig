import { runGit } from './exec.js';
import { validateRefName } from './refs-ops.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

/** Starting a repository in a folder that has none. */

const FALLBACK_BRANCH = 'main';

export function buildInitArgv(branch) {
  validateRefName(branch);
  if (branch.startsWith('-')) throw new TypeError('Invalid branch name');
  return ['init', `--initial-branch=${branch}`];
}

/** The person's `init.defaultBranch`, or `main`: a name Git would refuse is not offered. */
export async function loadDefaultBranch({ cwd, log }) {
  const result = await runGit({ argv: ['config', '--default', '', '--get', 'init.defaultBranch'], cwd, log, operation: 'Read the default branch name' });
  const name = result.code === 0 ? result.stdout.trim() : '';
  try {
    buildInitArgv(name);
    return name;
  } catch {
    return FALLBACK_BRANCH;
  }
}

/** @param {{ cwd: string, log: object, branch: string }} options */
export async function initRepository({ cwd, log, branch }) {
  const result = await runGit({ argv: buildInitArgv(branch), cwd, log, operation: 'Create a repository' });
  if (result.code !== 0) throw new Error(ui`Create a repository failed. See the command console.`);
}
