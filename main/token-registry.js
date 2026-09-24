import { randomUUID } from 'node:crypto';

/**
 * Paths the person picked in a native dialog — a patch file to apply, a folder
 * for a new worktree — held in main by an opaque token for a few minutes. The
 * renderer shows what was picked and sends the token back: a path from the
 * renderer is never read or handed to Git. A token belongs to one repository
 * and is spent on use.
 */
export function createTokenRegistry({ now = Date.now, lifetime = 15 * 60 * 1000 } = {}) {
  const entries = new Map();
  return {
    add(cwd, file) {
      for (const [token, entry] of entries) if (entry.expires < now()) entries.delete(token);
      const token = randomUUID();
      entries.set(token, { cwd, ...file, expires: now() + lifetime });
      return token;
    },
    take(cwd, token) {
      const entry = typeof token === 'string' ? entries.get(token) : null;
      if (!entry || entry.cwd !== cwd || entry.expires < now()) throw new TypeError('Choose the file or folder again.');
      entries.delete(token);
      return entry;
    }
  };
}
