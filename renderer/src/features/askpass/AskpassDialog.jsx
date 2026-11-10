import { useState } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { t, tn, tr } from '../../i18n/i18n.js';

const TITLES = {
  secret: () => t('Git needs a password'),
  text: () => t('Git needs an answer'),
  host: () => t('Trust this SSH host?'),
  confirm: () => t('SSH asks to confirm'),
  notice: () => t('SSH is waiting')
};

/**
 * What Git or ssh asked during an action the person started — a username, a
 * password or token, a key's passphrase, an unknown host key — shown word for
 * word: the prompt is Git's text, and from a remote it may say anything, so it
 * is only shown, never acted on. The answer goes to that one Git process and
 * nowhere else (see main/askpass.js); main takes the dialog away by itself
 * when Git ends, is cancelled or waited too long.
 */
export default function AskpassDialog({ view }) {
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  const answer = reply => {
    if (sent) return;
    setSent(true);
    setValue('');
    window.twig.answerAskpass(view.id, reply).catch(() => setSent(false));
  };
  const typed = view.kind === 'secret' || view.kind === 'text';
  const operation = tr(view.operation || '');
  const where = operation && view.folder ? t`Asked during ${operation} in ${view.folder}.` : operation ? t`Asked during ${operation}.` : '';
  const more = view.waiting > 1 ? tn(view.waiting - 1, '{n} more question waits after this one.', '{n} more questions wait after this one.') : '';
  const https = /\bhttps?:\/\//i.test(view.prompt);
  return <Dialog title={TITLES[view.kind]?.() ?? TITLES.text()} onClose={() => answer(null)}>
    <form className="confirm-dialog name-dialog askpass-dialog" onSubmit={event => {
      event.preventDefault();
      if (view.kind === 'host') answer('yes');
      else if (view.kind === 'confirm') answer('');
      else if (view.kind === 'notice') answer(null);
      else if (value) answer(value);
    }}>
      {where && <p className="muted">{where}</p>}
      <pre className="manager-output askpass-prompt" aria-label={t('What Git asked')}>{view.prompt}</pre>
      {view.kind === 'host' && <>
        <p className="confirm-consequence"><ShieldAlert size={16} aria-hidden="true" />{t('ssh has not connected to this host before and cannot tell whether it is the real one.')}</p>
        {view.fingerprint && <code className="confirm-command">{view.fingerprint}</code>}
        <p>{t('Compare the fingerprint with the one your Git host publishes. Trusting it lets ssh add the key to ~/.ssh/known_hosts.')}</p>
      </>}
      {typed && <>
        <label htmlFor="askpass-answer">{view.kind === 'secret' ? t('Password, token or passphrase') : t('Answer')}</label>
        <input id="askpass-answer" data-autofocus type={view.kind === 'secret' ? 'password' : 'text'} value={value} disabled={sent}
          autoComplete="off" spellCheck={false} onChange={event => setValue(event.target.value)} />
        {view.kind === 'secret' && https && <p className="muted"><KeyRound size={14} aria-hidden="true" /> {t('Over HTTPS, GitHub, GitLab and Bitbucket take a personal access token here, not your account password.')}</p>}
      </>}
      <p className="muted">{t('🌱 Twig hands the answer to Git and does not keep it.')}{more && ` ${more}`}</p>
      <div className="dialog-actions">
        {view.kind === 'notice'
          ? <Button className="primary" data-autofocus type="submit">{t('OK')}</Button>
          : <>
            <Button type="button" data-autofocus={view.kind === 'host' ? true : undefined} reason={sent ? t('Sent') : undefined} onClick={() => answer(null)}>{t('Cancel')}</Button>
            <Button className="primary" type="submit" reason={sent ? t('Sent') : typed && !value ? t('Type the answer first') : undefined}>
              {view.kind === 'host' ? t('Trust this host') : view.kind === 'confirm' ? t('Yes') : t('Send')}
            </Button>
          </>}
      </div>
    </form>
  </Dialog>;
}
