/**
 * What a commit's signature check means, in words. Only the i18n module is
 * imported: Vite and the Node check both load it.
 *
 * `status` is Git's `%G?`; `signed` comes from the commit object itself,
 * because Git answers `N` for an SSH signature it has no allowed-signers file
 * to check against, the same letter as for no signature at all.
 */
import { mark, t } from '../../i18n/i18n.js';

export const FORMAT_NAMES = Object.freeze({ ssh: 'SSH', openpgp: 'GPG', x509: 'X.509', unknown: mark('an unknown format') });

/**
 * @param {?{ signed: boolean, format: ?string, status: string, signer: ?string, key: ?string, trust: ?string }} signature
 * @returns {{ tone: 'good'|'warn'|'bad'|'none', label: string, detail: string }}
 */
export function signatureView(signature) {
  if (!signature) return { tone: 'none', label: t('Checking signature…'), detail: '' };
  if (!signature.signed) return { tone: 'none', label: t('Not signed'), detail: t('This commit carries no GPG, SSH or X.509 signature.') };
  const format = FORMAT_NAMES[signature.format] && signature.format !== 'unknown' ? FORMAT_NAMES[signature.format] : t(FORMAT_NAMES.unknown);
  const signer = signature.signer;
  const key = signature.key ? ` ${t`Key ${signature.key}.`}` : '';
  switch (signature.status) {
    case 'G': return { tone: 'good', label: t('Verified signature'),
      detail: (signer ? t`Signed with ${format} by ${signer}.` : t`Signed with ${format}.`) + key };
    case 'U': return { tone: 'warn', label: t('Signed, signer not trusted'),
      detail: (signature.format === 'ssh'
        ? t`The ${format} signature is valid, but the allowed signers file does not list this key for this signer.`
        : t`The ${format} signature is valid, but the key is not trusted in your keyring.`) + key };
    case 'X': return { tone: 'warn', label: t('Signature expired'),
      detail: (signer ? t`A valid ${format} signature by ${signer} that has expired.` : t`A valid ${format} signature that has expired.`) + key };
    case 'Y': return { tone: 'warn', label: t('Signed with an expired key'),
      detail: (signer ? t`A valid ${format} signature by ${signer}, made with a key that has since expired.`
        : t`A valid ${format} signature, made with a key that has since expired.`) + key };
    case 'R': return { tone: 'bad', label: t('Signed with a revoked key'),
      detail: (signer ? t`The ${format} key by ${signer} has been revoked.` : t`The ${format} key has been revoked.`) + key };
    case 'B': return { tone: 'bad', label: t('Bad signature'),
      detail: t`The commit does not match its ${format} signature: it was changed after signing, or the signature is forged.` + key };
    case 'E': return { tone: 'warn', label: t('Signature cannot be checked'),
      detail: signature.format === 'openpgp' ? t('gpg could not check it: the public key is missing from your keyring, or gpg is not installed.')
        : signature.format === 'ssh' ? t('ssh-keygen could not check it. Check gpg.ssh.allowedSignersFile in the Git profile.')
          : t`Git could not check this ${format} signature.` };
    default: return { tone: 'warn', label: t`Signed with ${format}, not verified`,
      detail: signature.format === 'ssh'
        ? t('Git verifies SSH signatures against an allowed signers file. Set gpg.ssh.allowedSignersFile in the Git profile.')
        : signature.format === 'openpgp' ? t('gpg is not installed or could not run, so Git could not check the signature.')
          : t('Git has no program configured to check this signature.') };
  }
}
