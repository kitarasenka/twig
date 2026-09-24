/**
 * What a commit's signature check means, in words. No imports: Vite and the
 * Node check both load it.
 *
 * `status` is Git's `%G?`; `signed` comes from the commit object itself,
 * because Git answers `N` for an SSH signature it has no allowed-signers file
 * to check against, the same letter as for no signature at all.
 */

export const FORMAT_NAMES = Object.freeze({ ssh: 'SSH', openpgp: 'GPG', x509: 'X.509', unknown: 'an unknown format' });

/**
 * @param {?{ signed: boolean, format: ?string, status: string, signer: ?string, key: ?string, trust: ?string }} signature
 * @returns {{ tone: 'good'|'warn'|'bad'|'none', label: string, detail: string }}
 */
export function signatureView(signature) {
  if (!signature) return { tone: 'none', label: 'Checking signature…', detail: '' };
  if (!signature.signed) return { tone: 'none', label: 'Not signed', detail: 'This commit carries no GPG, SSH or X.509 signature.' };
  const format = FORMAT_NAMES[signature.format] || FORMAT_NAMES.unknown;
  const who = signature.signer ? ` by ${signature.signer}` : '';
  const key = signature.key ? ` Key ${signature.key}.` : '';
  switch (signature.status) {
    case 'G': return { tone: 'good', label: 'Verified signature', detail: `Signed with ${format}${who}.${key}` };
    case 'U': return { tone: 'warn', label: 'Signed, signer not trusted',
      detail: signature.format === 'ssh'
        ? `The ${format} signature is valid, but the allowed signers file does not list this key for this signer.${key}`
        : `The ${format} signature is valid, but the key is not trusted in your keyring.${key}` };
    case 'X': return { tone: 'warn', label: 'Signature expired', detail: `A valid ${format} signature${who} that has expired.${key}` };
    case 'Y': return { tone: 'warn', label: 'Signed with an expired key', detail: `A valid ${format} signature${who}, made with a key that has since expired.${key}` };
    case 'R': return { tone: 'bad', label: 'Signed with a revoked key', detail: `The ${format} key${who} has been revoked.${key}` };
    case 'B': return { tone: 'bad', label: 'Bad signature', detail: `The commit does not match its ${format} signature: it was changed after signing, or the signature is forged.${key}` };
    case 'E': return { tone: 'warn', label: 'Signature cannot be checked',
      detail: signature.format === 'openpgp' ? 'gpg could not check it: the public key is missing from your keyring, or gpg is not installed.'
        : signature.format === 'ssh' ? 'ssh-keygen could not check it. Check gpg.ssh.allowedSignersFile in the Git profile.'
          : `Git could not check this ${format} signature.` };
    default: return { tone: 'warn', label: `Signed with ${format}, not verified`,
      detail: signature.format === 'ssh'
        ? 'Git verifies SSH signatures against an allowed signers file. Set gpg.ssh.allowedSignersFile in the Git profile.'
        : signature.format === 'openpgp' ? 'gpg is not installed or could not run, so Git could not check the signature.'
          : 'Git has no program configured to check this signature.' };
  }
}
