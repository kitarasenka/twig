import { formatList, t, tr } from '../i18n/i18n.js';
import { classifyFailure, splitFailure, tailLines } from './git-failure.js';

/**
 * The event App listens for: a button in a note anywhere opens one of its
 * dialogs (Git profile, SSH, Remotes) or asks about removing a lock, without
 * every screen being handed App's setters.
 */
export const FAILURE_ACTION = 'twig:failure-action';
export const FAILURE_DIALOGS = ['Git profile', 'SSH', 'Remotes'];

function ask(detail) {
  window.dispatchEvent(new CustomEvent(FAILURE_ACTION, { detail }));
}

const LABELS = { 'Git profile': () => t('Open Git profile'), SSH: () => t('Open SSH settings'), Remotes: () => t('Open remotes') };
const openDialog = name => ({ label: LABELS[name](), run: () => ask({ dialog: name }) });

/**
 * A failure note that says what went wrong in words and offers the way out:
 * `{ text, detail, failed: true, actions? }` for OperationNote (and the error
 * strip of the staging screen). `failure` is an Error from IPC or a result
 * `{ ok: false, message, reason, hooks }`; `fallback` is the sentence when it
 * has no message. Git's own last line is the detail, untranslated.
 * @param {unknown} failure
 * @param {string} fallback
 * @param {{ repositoryId?: ?string, prefix?: string }} [options]
 */
export function failureNote(failure, fallback, { repositoryId = null, prefix = '' } = {}) {
  const { message, reason, hooks } = splitFailure(failure);
  const sentence = message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '').replace(/^Error:\s*/, '').trim();
  const said = sentence ? tr(sentence) : fallback;
  const lead = text => (prefix ? `${prefix}: ${text}` : text);
  const found = classifyFailure(reason, { hooks });
  switch (found.kind) {
    case 'lock': {
      const name = found.lock.split(/[\\/]/).pop();
      return { failed: true, detail: found.line, text: lead(t`Git found ${name} left over: another Git program is working in this repository, or one stopped halfway.`),
        actions: repositoryId ? [{ label: t('Remove the lock…'), run: () => ask({ lock: found.lock, repositoryId }) }] : [] };
    }
    case 'identity':
      return { failed: true, detail: found.line, text: lead(t('Git does not know who you are yet: set the name and email for your commits first.')), actions: [openDialog('Git profile')] };
    case 'signing':
      return { failed: true, detail: found.line, text: lead(t('Git could not sign the commit. Check the signing key in the Git profile, or turn signing off there.')), actions: [openDialog('Git profile')] };
    case 'host-key':
      return { failed: true, detail: found.line, text: lead(t('SSH does not trust this host yet, so Git stopped before connecting.')), actions: [openDialog('SSH')] };
    case 'ssh-auth':
      return { failed: true, detail: found.line, text: lead(t('The remote refused your SSH key. Add the public key to your account on the Git host, or check which key SSH offers.')), actions: [openDialog('SSH')] };
    case 'https-auth':
      return { failed: true, detail: found.line, text: lead(t('The remote asked for a user name and a password or token, and Git had none to give. Set up a credential helper, or use an SSH address.')), actions: [openDialog('Remotes')] };
    case 'network':
      return { failed: true, detail: found.line, text: lead(t('Git could not reach the remote. Check the network connection and the remote address.')), actions: [openDialog('Remotes')] };
    case 'hook':
      return { failed: true, detail: tailLines(reason), text: lead(found.hooks.length === 1
        ? t`The ${found.hooks[0]} hook stopped it. What it printed:`
        : t`A Git hook stopped it (${formatList(found.hooks, 'disjunction')}). What it printed:`) };
    case 'other':
      return { failed: true, detail: found.line || undefined, text: lead(said) };
    default:
      return { failed: true, text: lead(said) };
  }
}
