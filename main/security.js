import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isLocalAsset(url, directory) {
  try {
    if (new URL(url).protocol !== 'file:') return false;
    const relative = path.relative(directory, fileURLToPath(url));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export function isTrustedPage(url, entryUrl) {
  try {
    const candidate = new URL(url);
    const entry = new URL(entryUrl);
    return candidate.protocol === entry.protocol && candidate.host === entry.host
      && candidate.pathname === entry.pathname && candidate.search === entry.search;
  } catch {
    return false;
  }
}

export function isExternalLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'mailto:') {
      // A commit author's email, opened in the system mail client. No query
      // string: the repository never gets to prefill a subject or body.
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.pathname) && !parsed.search;
    }
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
