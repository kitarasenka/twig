import { runGit } from './exec.js';
import { validateOid } from './commit.js';

/**
 * Whether a commit is signed, and whether the signature checks out.
 *
 * Git's own answer (`%G?`) is not enough on its own: an SSH signature with no
 * `gpg.ssh.allowedSignersFile` configured comes back as `N`, "no signature",
 * exactly like an unsigned commit — and a signature whose program (gpg) is
 * missing can too. So whether a signature is *there* is read from the commit
 * object's own `gpgsig` header, and `%G?` only says what verifying it gave.
 */

const BEGIN = [
  ['-----BEGIN SSH SIGNATURE-----', 'ssh'],
  ['-----BEGIN PGP SIGNATURE-----', 'openpgp'],
  ['-----BEGIN SIGNED MESSAGE-----', 'x509']
];

/**
 * The signature format named by a raw commit object's headers, or null when
 * it carries none. Headers end at the first empty line; the message after it
 * may quote a signature block without being signed.
 * @param {string} raw `git cat-file commit <oid>`
 */
export function signatureFormat(raw) {
  const headers = raw.split('\n\n', 1)[0].split('\n');
  const at = headers.findIndex(line => /^gpgsig(?:-sha256)? /.test(line));
  if (at < 0) return null;
  const first = headers[at].slice(headers[at].indexOf(' ') + 1).trim();
  return BEGIN.find(([marker]) => first === marker)?.[1] ?? 'unknown';
}

const FORMAT = '%G?%x00%GS%x00%GK%x00%GF%x00%GT';

/** @param {string} output `git show -s --format=FORMAT` */
export function parseVerification(output) {
  const [status = '', signer = '', key = '', fingerprint = '', trust = ''] = output.replace(/\n$/, '').split('\0');
  if (!/^[GBUXYREN]$/.test(status)) throw new Error('Invalid signature output');
  const clean = value => (value && value !== 'undefined' ? value : null);
  return { status, signer: clean(signer), key: clean(key), fingerprint: clean(fingerprint), trust: clean(trust) };
}

/**
 * @param {{ cwd: string, log: object, oid: string }} options
 * @returns {Promise<{ signed: boolean, format: ?string, status: string, signer: ?string, key: ?string, fingerprint: ?string, trust: ?string }>}
 */
export async function loadSignature({ cwd, log, oid }) {
  validateOid(oid);
  const raw = await runGit({ cwd, log, argv: ['cat-file', 'commit', oid], operation: 'Read commit signature' });
  if (raw.code !== 0) throw new Error('Git could not read this commit.');
  const format = signatureFormat(raw.stdout);
  if (!format) return { signed: false, format: null, status: 'N', signer: null, key: null, fingerprint: null, trust: null };
  // Verifying runs the signature program (gpg, ssh-keygen or gpgsm) through Git.
  const checked = await runGit({ cwd, log, argv: ['show', '--no-show-signature', '-s', `--format=${FORMAT}`, oid, '--'], operation: 'Read commit signature verification' });
  if (checked.code !== 0) return { signed: true, format, status: 'E', signer: null, key: null, fingerprint: null, trust: null };
  return { signed: true, format, ...parseVerification(checked.stdout) };
}
