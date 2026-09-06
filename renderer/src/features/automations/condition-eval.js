/**
 * Turns the visual conditions on a pipeline or an action into a yes/no against
 * the context main assembled for a Git event. There are no shell expressions:
 * every condition is one of a small set of typed rules.
 *
 * context = {
 *   branch: string|null,        // current branch, null when detached
 *   remote: string|null,        // push target, only set for pre-push
 *   changedFiles: string[],     // repo-relative paths in play for this event
 *   commitMessage: string|null, // only set for commit-msg / prepare-commit-msg
 *   operation: string           // 'commit' | 'push' | 'merge' | 'rebase' | ...
 * }
 *
 * No imports: loaded by Vite and by Node in `scripts/checks/automation.mjs`.
 */

/** `*` matches within a path segment, `**` across segments, `?` one character. */
export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` and `**` swallow any number of segments (including none).
        i++;
        if (glob[i + 1] === '/') i++;
        out += '(?:.*/)?';
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

export function matchesGlob(path, glob) {
  return globToRegExp(glob).test(path);
}

function evaluateOne(condition, context) {
  const negate = condition.negate === true;
  let result;
  switch (condition.type) {
    case 'changedFiles': {
      const glob = String(condition.glob || '');
      const hit = (context.changedFiles || []).some(path => matchesGlob(path, glob));
      // mode 'none' passes when nothing matches; default 'any' passes on a hit.
      result = condition.mode === 'none' ? !hit : hit;
      break;
    }
    case 'branch': {
      const branch = context.branch;
      result = branch != null && matchesGlob(branch, String(condition.pattern || ''));
      break;
    }
    case 'remote': {
      result = context.remote != null && context.remote === condition.name;
      break;
    }
    case 'messageContains': {
      const message = context.commitMessage;
      result = typeof message === 'string' && message.includes(String(condition.text || ''));
      break;
    }
    default:
      // An unknown condition type never silently passes: it fails closed.
      return false;
  }
  return negate ? !result : result;
}

/** Every condition must hold (AND). An empty list always passes. */
export function evaluateConditions(conditions, context) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return conditions.every(condition => evaluateOne(condition, context));
}
