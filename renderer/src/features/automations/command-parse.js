/**
 * Turns a command string an automation action holds ("npm run lint") into an
 * argv array for `spawn(executable, argv, { shell: false })`. There is no shell
 * anywhere in this feature, so this parser is the whole contract:
 *
 *  - it splits on whitespace, honouring single and double quotes;
 *  - it performs NO expansion — no globs, no `$VAR`, no `~`, no command
 *    substitution;
 *  - it REFUSES shell metacharacters outright (`& | ; < > $ \` and newlines).
 *    A command that needs to chain is expressed as two actions, not one
 *    string, so an action always maps to exactly one process. Parentheses are
 *    left alone: without a shell they are ordinary characters in an argument
 *    (a regex, a version range) and never a subshell.
 *
 * A rejection throws, and the caller turns that into a refused IPC request or a
 * red field in the editor — never a silently-run fallback.
 *
 * No imports: loaded by Vite and by Node in `scripts/checks/automation.mjs`.
 */

const FORBIDDEN = /[;&|<>$`\n\r]/;

export function parseCommand(input) {
  if (typeof input !== 'string') throw new TypeError('A command must be a string.');
  const text = input.trim();
  if (!text) throw new TypeError('A command cannot be empty.');
  if (text.length > 4096) throw new TypeError('This command is too long.');
  if (FORBIDDEN.test(text)) {
    throw new TypeError('A command cannot contain shell operators (& | ; < > $ ` or newlines). Add another action instead.');
  }

  const argv = [];
  let current = '';
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) { quote = null; continue; }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; hasToken = true; continue; }
    if (char === '\\') {
      // A backslash only escapes the next literal character; it never introduces
      // shell behaviour because there is no shell.
      const next = text[i + 1];
      if (next === undefined) throw new TypeError('A command cannot end with a lone backslash.');
      current += next; i++; hasToken = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (hasToken) { argv.push(current); current = ''; hasToken = false; }
      continue;
    }
    current += char; hasToken = true;
  }
  if (quote) throw new TypeError('This command has an unbalanced quote.');
  if (hasToken) argv.push(current);
  if (argv.length === 0) throw new TypeError('A command cannot be empty.');
  return argv;
}

/**
 * The first token is the executable. It is accepted only as a bare program name
 * (resolved through PATH by the OS) — a path is validated separately against the
 * working tree by the runner, because "run a script from the repository" is a
 * different, narrower permission.
 */
export function isBareExecutable(name) {
  return typeof name === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name) && name.length <= 128;
}
