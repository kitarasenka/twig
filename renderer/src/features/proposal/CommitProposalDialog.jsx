import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { t, tn, tr } from '../../i18n/i18n.js';
import { actionLabels, primaryAction, proposalCommands, pushLine, releaseState, stepLabel, totalsLine, waitingLine } from './proposal-view.js';

const STEPS = ['patch', 'minor', 'major'];

/**
 * A commit an agent proposed through MCP (propose_commit, or new_version for
 * a release). Nothing has happened yet: the person sees where it goes, every
 * file it takes and the message (which they may edit), whether the version is
 * bumped and the commit tagged (two switches, both theirs to change), and the
 * exact commands; Commit or Commit & Push runs 🌱 Twig's own commit, tag and
 * push, with the automations and Undo they always have.
 */
export default function CommitProposalDialog({ view, running, step, failure, invalid, onDecide, onClose }) {
  const startChoice = view.defaults?.bump ?? view.bump?.choice ?? 'none';
  // null: the message follows the version (a release the agent left unworded) until typed in.
  const [message, setMessage] = useState(view.message);
  const [bumpOn, setBumpOn] = useState(startChoice !== 'none');
  const [bumpStep, setBumpStep] = useState(STEPS.includes(startChoice) ? startChoice : 'patch');
  const [tagOn, setTagOn] = useState(Boolean(view.defaults?.tag));
  // null: the name follows the version until the person types one.
  const [tagName, setTagName] = useState(view.defaults?.tagName ?? null);
  // A refreshed proposal (the files changed) keeps what the person typed and chose.
  useEffect(() => { if (!view.stale) setMessage(view.message); }, [view.id, view.stale, view.message]);

  const versioned = Boolean(view.bump || view.versioning?.tag);
  // Without a package.json the version exists only in the tag, so bumping means nothing untagged.
  const tagOnlyVersion = !view.bump && Boolean(view.versioning?.tag);
  const choice = versioned && bumpOn && (!tagOnlyVersion || tagOn) ? bumpStep : 'none';
  const release = releaseState(view, { choice, tagOn, tagName, message });
  const primary = primaryAction(view);
  const labels = actionLabels(release.commit);
  const empty = release.commit && release.message.trim().length === 0;
  const busyReason = running ? (release.commit ? t('Committing…') : t('Tagging…')) : undefined;
  const pushReason = !view.pushTarget?.mode ? t('There is nowhere to push') : undefined;
  const blocked = (empty ? t('Write a commit message') : undefined) || release.tagProblem
    || (!release.commit && !release.tag ? t('Nothing to commit: bump the version or create a tag') : undefined);
  const decide = action => onDecide({ action, message: release.message, bump: view.bump ? choice : null, tag: release.tag });
  const commands = proposalCommands(view, primary === 'commit-push', { commit: release.commit, tag: release.tag });
  const newVersions = choice === 'none' ? [] : view.bump
    ? view.bump.targets.map(target => ({ path: target.path, version: target.next[choice] }))
    : [{ path: 'tag', version: release.version }];
  const source = view.bump?.source === 'automation' ? t('from your “Bump version” automation')
    : view.bump ? t`${view.bump.targets[0].path} is ${view.bump.targets[0].current}`
      : view.versioning?.tag ? t`no package.json — the version is in the tag, now ${view.versioning.tag.version}` : '';
  const heading = view.files.length ? <>{t('Everything below is staged and committed')} <span className="muted">· {totalsLine(view)}</span></>
    : release.commit ? <>{t('Nothing else changed')} <span className="muted">· {t('the commit is the version bump alone')}</span></>
      : <>{t('Nothing changed')} <span className="muted">· {t`only ${view.head} is tagged`}</span></>;

  // Esc or the close button is a Cancel while the proposal is open, and just closes once it has failed.
  return <Dialog title={view.kind === 'release' ? t('New version proposed by an agent') : t('Commit proposed by an agent')} wide
    onClose={failure ? onClose : () => decide('cancel')} closeReason={busyReason}>
    <div className="proposal-dialog">
      <p className="proposal-where"><Bot aria-hidden="true" /><span><strong title={view.repository.path}>{view.repository.name}</strong> · {view.branch}{view.unborn ? ` ${t('(first commit)')}` : ''}<small>{pushLine(view)}</small></span></p>
      {view.waiting > 0 && <p className="proposal-waiting" role="status">{waitingLine(view.waiting)}</p>}
      {view.stale && <p className="proposal-stale" role="alert">{t('The files changed after the agent proposed this. Check the list and the message again.')}</p>}
      <h3 className="proposal-heading">{heading}</h3>
      {view.files.length > 0 && <ul className="proposal-files" aria-label={t('Files in this commit')} tabIndex={0}>
        {view.files.map(file => <li key={file.path}><code>{file.line}</code></li>)}
      </ul>}
      {release.commit && <>
        <label htmlFor="proposal-message">{t('Message')} <span className="muted">— {view.message === null ? t('follows the version until you edit it') : t('written by the agent, yours to edit')}</span></label>
        <textarea id="proposal-message" rows={6} value={release.message} spellCheck autoFocus onChange={event => setMessage(event.target.value)} disabled={running} />
      </>}
      <div className="proposal-release" role="group" aria-label={t('Version and tag')}>
        {versioned && <div className="proposal-switch-row">
          <label className="switch"><input type="checkbox" checked={bumpOn} disabled={running} onChange={event => setBumpOn(event.target.checked)} /><span className="track" />{t('Bump version')}</label>
          <select aria-label={t('Version step')} value={bumpStep} disabled={running || !bumpOn || (tagOnlyVersion && !tagOn)} onChange={event => setBumpStep(event.target.value)}>
            {STEPS.map(item => <option key={item} value={item}>{stepLabel(view, item)}</option>)}
          </select>
          <span className="muted">{tagOnlyVersion && !tagOn ? t('Turn on the tag: without a package.json the version lives only in it') : source}</span>
        </div>}
        {newVersions.length > 0 && <p className="proposal-bump-new" aria-live="polite">
          {tn(newVersions.length, 'New version:', 'New versions:')} {newVersions.map(({ path, version }) => <code key={path}>{path === 'tag' ? version : `${path} ${version}`}</code>)}
        </p>}
        <div className="proposal-switch-row">
          <label className="switch"><input type="checkbox" checked={tagOn} disabled={running} onChange={event => setTagOn(event.target.checked)} /><span className="track" />{release.commit ? t('Tag this commit') : t`Tag ${view.head}`}</label>
          <input type="text" aria-label={t('Tag name')} spellCheck={false} value={tagOn ? release.tag : ''} placeholder={tagOn ? 'v1.0.0' : t('No tag')}
            disabled={running || !tagOn} aria-invalid={Boolean(release.tagProblem)} onChange={event => setTagName(event.target.value)} />
          <span className="muted">{view.versioning?.tag ? t`previous: ${view.versioning.tag.name}` : t('no earlier version tag')}</span>
          {tagName !== null && tagOn && <button type="button" className="text-button" disabled={running} onClick={() => setTagName(null)}>{t('Follow the version')}</button>}
        </div>
        {release.tagProblem && <p className="proposal-tag-problem" role="alert">{release.tagProblem}</p>}
        {tagOn && primary === 'commit-push' && view.pushTarget?.remote && <p className="muted">{t`Commit & Push sends the tag to ${view.pushTarget.remote} too.`}</p>}
      </div>
      <p className="muted">{release.commit ? t('These commands will run, after your pre-commit automations:') : t('These commands will run:')}</p>
      <code className="confirm-command proposal-commands">{commands.map(line => <span key={line}>$ {line}</span>)}</code>
      {invalid && !running && <p className="proposal-tag-problem" role="alert">{tr(invalid)}</p>}
      {running && <p role="status" className="proposal-progress">{step ? `${step.name}: ${t(step.status)}` : busyReason}</p>}
      {failure && <pre className="proposal-failure" role="alert">{tr(failure)}</pre>}
      {failure ? <div className="dialog-actions"><Button className="primary" onClick={onClose}>{t('Close')}</Button></div> : <div className="dialog-actions">
        <Button onClick={() => decide('cancel')} reason={busyReason}>{t('Cancel')}</Button>
        <Button className={primary === 'commit' ? 'primary' : undefined} onClick={() => decide('commit')}
          reason={busyReason || blocked}>{labels.commit}</Button>
        <Button className={primary === 'commit-push' ? 'primary' : undefined} onClick={() => decide('commit-push')}
          reason={busyReason || pushReason || blocked}>{labels.push}</Button>
      </div>}
    </div>
  </Dialog>;
}
