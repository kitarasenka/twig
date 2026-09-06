/**
 * Commit-message checks for the "Validate commit message" action. Pure and
 * import-free: loaded by Vite and by Node in `scripts/checks/automation.mjs`.
 *
 * Returns { ok, detail } — `detail` is the one-line reason shown when a
 * commit-msg pipeline blocks the commit.
 */

const CONVENTIONAL = /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?: .+/;

export function checkMessage(rule, message) {
  const subject = typeof message === 'string' ? message.split('\n', 1)[0].trim() : '';
  if (!subject) return { ok: false, detail: 'The commit message is empty.' };

  switch (rule?.mode) {
    case 'conventional':
      return CONVENTIONAL.test(subject)
        ? { ok: true, detail: null }
        : { ok: false, detail: 'Subject must look like "type(scope): summary" (Conventional Commits).' };

    case 'ticketPrefix': {
      const prefix = String(rule.prefix || '').trim();
      if (!prefix) return { ok: false, detail: 'No ticket prefix is configured.' };
      // "PROJ" -> requires "PROJ-123: ..." at the start of the subject.
      const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+[: ]`);
      return pattern.test(subject)
        ? { ok: true, detail: null }
        : { ok: false, detail: `Subject must start with a ${prefix}-NNN ticket reference.` };
    }

    case 'regex': {
      const source = String(rule.pattern || '');
      if (!source) return { ok: false, detail: 'No pattern is configured.' };
      let expression;
      try { expression = new RegExp(source, rule.flags && /^[gimsuy]*$/.test(rule.flags) ? rule.flags : ''); }
      catch { return { ok: false, detail: 'The configured pattern is not a valid regular expression.' }; }
      return expression.test(rule.matchFullMessage ? String(message) : subject)
        ? { ok: true, detail: null }
        : { ok: false, detail: `The commit message does not match ${source}.` };
    }

    default:
      return { ok: false, detail: 'This message rule is not configured.' };
  }
}
