// What a failed Git command means, read from the tail of its output. No
// imports: Vite and the Node check both load it. The words are in
// `failure-note.js`; this only says which case it is.
//
// The text Git prints is data: nothing here is shown as a sentence of 🌱 Twig,
// only `line` (Git's own last line) as the detail under one.

/** The same mark as `main/git/failure.js`: the reason rides inside an Error's message after it. */
export const DETAIL_MARK = '\u0000twig:detail\u0000';

/**
 * A failure from IPC (an Error, its message, or a `{ message, reason }`
 * result) split into the sentence and what Git said.
 * @returns {{ message: string, reason: string, hooks: string[] }}
 */
export function splitFailure(failure) {
  const raw = typeof failure === 'string' ? failure : typeof failure?.message === 'string' ? failure.message : '';
  const at = raw.indexOf(DETAIL_MARK);
  let reason = typeof failure?.reason === 'string' ? failure.reason : '';
  let hooks = Array.isArray(failure?.hooks) ? failure.hooks : [];
  if (at >= 0) {
    try {
      const detail = JSON.parse(raw.slice(at + DETAIL_MARK.length));
      if (typeof detail?.reason === 'string') reason = detail.reason;
      if (Array.isArray(detail?.hooks)) hooks = detail.hooks;
    } catch { /* a message that only looks marked keeps its sentence */ }
  }
  return { message: at >= 0 ? raw.slice(0, at) : raw, reason, hooks: hooks.filter(name => typeof name === 'string') };
}

const NOISE = /^(hint|remote: *$|To |From )/;

/**
 * The line of Git's output worth showing: the last `fatal:`/`error:` line
 * without its prefix, else the last line that is not a hint.
 */
export function lastLine(reason) {
  const lines = String(reason || '').split('\n').map(line => line.trim()).filter(line => line && !NOISE.test(line));
  const marked = lines.filter(line => /^(fatal|error):/i.test(line));
  const line = (marked.length ? marked[marked.length - 1] : lines[lines.length - 1]) || '';
  return line.replace(/^(fatal|error):\s*/i, '').slice(0, 300);
}

/** The last few lines of what a hook printed, for the detail under the sentence. */
export function tailLines(reason, count = 4) {
  return String(reason || '').split('\n').map(line => line.trimEnd()).filter(line => line.trim()).slice(-count).join('\n').slice(-600);
}

// Hooks that can stop each kind of action, in the order Git runs them.
export const STOPPING_HOOKS = {
  commit: ['pre-commit', 'prepare-commit-msg', 'commit-msg'],
  push: ['pre-push'],
  merge: ['pre-merge-commit', 'commit-msg'],
  rebase: ['pre-rebase'],
  checkout: []
};

/**
 * Which case a failure is. `hooks`: the executable hooks main found for this
 * action; a failure no other case explains, with one of them present, is put
 * down to the hook.
 * @returns {{ kind: 'lock'|'identity'|'signing'|'ssh-auth'|'host-key'|'https-auth'|'network'|'hook'|'other'|'none',
 *   lock?: string, hooks?: string[], line: string }}
 */
export function classifyFailure(reason, { hooks = [] } = {}) {
  const text = String(reason || '');
  const line = lastLine(text);
  if (!text.trim()) return { kind: 'none', line };
  const lock = text.match(/Unable to create '([^'\n]+\.lock)': File exists/i);
  if (lock) return { kind: 'lock', lock: lock[1], line };
  if (/Please tell me who you are|empty ident name|unable to auto-detect email address|Author identity unknown|Committer identity unknown|no email was given/i.test(text)) {
    return { kind: 'identity', line };
  }
  if (/(gpg|ssh-keygen|signing)[^\n]*fail|failed to sign the data|gpg: signing failed|Couldn't (load|find) (public )?key|incorrect passphrase supplied/i.test(text)) {
    return { kind: 'signing', line };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (ED25519|RSA|ECDSA)? ?host key is known/i.test(text)) return { kind: 'host-key', line };
  if (/Permission denied \(publickey|Permission denied, please try again|sign_and_send_pubkey|no mutual signature/i.test(text)) return { kind: 'ssh-auth', line };
  if (/Authentication failed for|could not read (Username|Password) for|Invalid username or password|password authentication was removed|HTTP Basic: Access denied|The requested URL returned error: 40[13]/i.test(text)) {
    return { kind: 'https-auth', line };
  }
  if (/Could not resolve host|Could not resolve hostname|Connection timed out|Connection refused|Failed to connect to|Network is unreachable|Operation timed out|Could not read from remote repository/i.test(text)
    && !/Permission denied/i.test(text)) {
    return { kind: 'network', line };
  }
  if (hooks.length) return { kind: 'hook', hooks: [...hooks], line };
  return { kind: 'other', line };
}
