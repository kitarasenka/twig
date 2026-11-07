import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import DiffLines from '../diff/DiffLines.jsx';
import { failureText, t, tn, tr } from '../../i18n/i18n.js';
import { actionLabels, primaryAction, proposalCommands, pushLine, releaseState, replacedLines, staleLine, stepLabel, totalsLine, waitingLine } from './proposal-view.js';

const STEPS = ['patch', 'minor', 'major'];
/** How long the buttons stay off after a proposal was swapped under the person. */
const REPLACED_HOLD_MS = 1500;
/** The window comes up by itself, over whatever the person was typing in: Enter and Space wait this long. */
const KEYS_HOLD_MS = 1000;

/**
 * A commit an agent proposed through MCP (propose_commit, or new_version for
 * a release). Nothing has happened yet: the person sees where it goes, every
 * file it takes and the message (which they may edit), whether the version is
 * bumped and the commit tagged (two switches, both theirs to change), and the
 * exact commands; Commit or Commit & Push runs 🌱 Twig's own commit, tag and
 * push, with the automations and Undo they always have. A click on a file shows
 * its change, from the very tree the commit takes.
 *
 * A proposal that replaced the one on screen says what it brought, and the
 * buttons wait for an "I have read it": a click meant for the old proposal must
 * not land on the new one.
 */
export default function CommitProposalDialog({ view, running, step, failure, invalid, onDecide, onClose, onStopAgents }) {
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
  const [held, setHeld] = useState(Boolean(view.replaced));
  const [holdOver, setHoldOver] = useState(false);
  useEffect(() => {
    if (!view.replaced) return undefined;
    const timer = setTimeout(() => setHoldOver(true), REPLACED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [view.replaced]);
  // { path, loading } while it reads, then { path, patch } or { path, note }.
  const [opened, setOpened] = useState(null);
  const reading = useRef(0);
  useEffect(() => { reading.current++; setOpened(null); }, [view]);
  async function toggleFile(path) {
    const mine = ++reading.current;
    if (opened?.path === path) { setOpened(null); return; }
    setOpened({ path, loading: true });
    try {
      const diff = await window.twig.getCommitProposalFile(view.id, path);
      if (mine === reading.current) setOpened({ path, ...diff });
    } catch (error) {
      if (mine === reading.current) setOpened({ path, note: failureText(error, t('Could not read this file.')) });
    }
  }
  // Esc on an edited message asks first; a second Esc goes back to the message.
  const [leaving, setLeaving] = useState(false);
  const field = useRef(null);
  const keepEditing = useRef(null);
  useEffect(() => { (leaving ? keepEditing.current?.querySelector('button') : field.current)?.focus(); }, [leaving]);
  useEffect(() => {
    const opened = performance.now();
    const hold = event => {
      if ((event.key === 'Enter' || event.key === ' ') && performance.now() - opened < KEYS_HOLD_MS) { event.preventDefault(); event.stopPropagation(); }
    };
    addEventListener('keydown', hold, true);
    return () => removeEventListener('keydown', hold, true);
  }, []);

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
  const blocked = (held ? t('Read the new proposal first') : undefined) || (empty ? t('Write a commit message') : undefined) || release.tagProblem
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
  // A message the person has edited is theirs: those two ask before it is thrown away.
  const edited = message !== null && message !== view.message;
  const close = failure ? onClose : () => { if (edited) setLeaving(value => !value); else decide('cancel'); };
  return <Dialog title={view.kind === 'release' ? t('New version proposed by an agent') : t('Commit proposed by an agent')} wide
    onClose={close} closeReason={busyReason}>
    <div className="proposal-dialog">
      <p className="proposal-where"><Bot aria-hidden="true" /><span><strong title={view.repository.path}>{view.repository.name}</strong> · {view.branch}{view.unborn ? ` ${t('(first commit)')}` : ''}<small>{pushLine(view)}</small>
        {view.pushTarget?.urls?.map(url => <small key={url}><code className="proposal-url">{url}</code></small>)}
        {view.pushTarget?.notes?.map(note => <small key={note} className="proposal-push-note">{tr(note)}</small>)}</span></p>
      {view.waiting > 0 && <p className="proposal-waiting" role="status">{waitingLine(view.waiting)}</p>}
      {view.stale && <p className="proposal-stale" role="alert">{staleLine(view)}</p>}
      {held && <div className="proposal-stale proposal-replaced" role="alert">
        {replacedLines(view).map(line => <p key={line}>{line}</p>)}
        <Button reason={holdOver ? undefined : t('Read the new proposal first')} onClick={() => setHeld(false)}>{t('I have read it')}</Button>
      </div>}
      <h3 className="proposal-heading" tabIndex={-1} data-autofocus={release.commit ? undefined : true}>{heading}</h3>
      {view.files.length > 0 && <ul className="proposal-files" aria-label={t('Files in this commit')} tabIndex={0}>
        {view.files.map(file => <li key={file.path}><button type="button" className="proposal-file" aria-expanded={opened?.path === file.path} onClick={() => void toggleFile(file.path)}><code>{file.line}</code></button></li>)}
      </ul>}
      {opened && <div className="proposal-diff" aria-busy={Boolean(opened.loading)}>
        {opened.patch ? <DiffLines patch={opened.patch} path={opened.path} label={t`Changes in ${opened.path}`} />
          : <p className="muted">{opened.loading ? t('Reading…') : tr(opened.note)}</p>}
      </div>}
      {release.commit && <>
        <label htmlFor="proposal-message">{t('Message')} <span className="muted">— {view.message === null ? t('follows the version until you edit it') : t('written by the agent, yours to edit')}</span></label>
        <textarea id="proposal-message" ref={field} rows={6} value={release.message} spellCheck data-autofocus onChange={event => setMessage(event.target.value)} disabled={running} />
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
      <p className="muted">{release.commit ? t('These commands will run, after your pre-commit automations; Git runs this repository’s hooks with them:') : t('These commands will run:')}</p>
      <code className="confirm-command proposal-commands">{commands.map(line => <span key={line}>$ {line}</span>)}</code>
      {release.commit && view.hooks?.length > 0 && <p className="muted">{t`Git hooks in this repository that run with it: ${view.hooks.join(', ')}`}</p>}
      {invalid && !running && <p className="proposal-tag-problem" role="alert">{tr(invalid)}</p>}
      {running && <p role="status" className="proposal-progress">{step ? `${step.name}: ${t(step.status)}` : busyReason}</p>}
      {failure && <pre className="proposal-failure" role="alert">{tr(failure)}</pre>}
      {leaving && !failure && !running && <div className="proposal-leaving" role="alert" ref={keepEditing}><span>{t('Cancel this proposal and lose your edits to the message?')}</span>
        <Button onClick={() => setLeaving(false)}>{t('Keep editing')}</Button>
        <Button className="danger" onClick={() => decide('cancel')}>{t('Cancel the proposal')}</Button></div>}
      {failure ? <div className="dialog-actions"><Button className="primary" onClick={onClose}>{t('Close')}</Button></div> : <div className="dialog-actions">
        <button type="button" className="text-button proposal-stop" disabled={running} onClick={onStopAgents}>{t('Stop agents proposing commits')}</button>
        <Button onClick={() => decide('cancel')} reason={busyReason}>{t('Cancel')}</Button>
        <Button className={primary === 'commit' ? 'primary' : undefined} onClick={() => decide('commit')}
          reason={busyReason || blocked}>{labels.commit}</Button>
        <Button className={primary === 'commit-push' ? 'primary' : undefined} onClick={() => decide('commit-push')}
          reason={busyReason || pushReason || blocked}>{labels.push}</Button>
      </div>}
    </div>
  </Dialog>;
}
