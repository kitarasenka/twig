import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { primaryAction, proposalCommands, pushLine, totalsLine } from './proposal-view.js';
import { BUMP_CHOICES, bumpLabel } from '../automations/version-bump.js';

/**
 * A commit an agent proposed through MCP. Nothing has happened yet: the
 * person sees where it goes, every file it takes and the message (which they
 * may edit), and the exact commands; Commit or Commit & Push runs 🌱 Twig's own
 * commit and push, with the automations and Undo they always have.
 */
export default function CommitProposalDialog({ view, running, step, failure, onDecide, onClose }) {
  const [message, setMessage] = useState(view.message);
  const [bump, setBump] = useState(view.bump?.choice ?? null);
  // A refreshed proposal (the files changed) keeps what the person typed.
  useEffect(() => { if (!view.stale) setMessage(view.message); }, [view.id, view.stale, view.message]);
  useEffect(() => { setBump(view.bump?.choice ?? null); }, [view.id, view.bump?.choice]);
  const primary = primaryAction(view);
  const empty = message.trim().length === 0;
  const busyReason = running ? 'Committing…' : undefined;
  const pushReason = !view.pushTarget?.mode ? 'There is nowhere to push' : undefined;
  const decide = action => onDecide({ action, message, bump: view.bump ? bump : null });
  const commands = proposalCommands(view, primary === 'commit-push');
  const newVersions = view.bump?.targets?.flatMap(target => {
    const version = target.next?.[bump];
    return version ? [{ path: target.path, version }] : [];
  }) ?? [];

  // Esc or the close button is a Cancel while the proposal is open, and just closes once it has failed.
  return <Dialog title="Commit proposed by an agent" wide onClose={failure ? onClose : () => decide('cancel')} closeReason={busyReason}>
    <div className="proposal-dialog">
      <p className="proposal-where"><Bot aria-hidden="true" /><span><strong>{view.repository.name}</strong> · {view.branch}{view.unborn ? ' (first commit)' : ''}<small>{pushLine(view)}</small></span></p>
      {view.stale && <p className="proposal-stale" role="alert">The files changed after the agent proposed this. Check the list and the message again.</p>}
      <h3 className="proposal-heading">Everything below is staged and committed <span className="muted">· {totalsLine(view)}</span></h3>
      <ul className="proposal-files" aria-label="Files in this commit" tabIndex={0}>
        {view.files.map(file => <li key={file.path}><code>{file.line}</code></li>)}
      </ul>
      <label htmlFor="proposal-message">Message <span className="muted">— written by the agent, yours to edit</span></label>
      <textarea id="proposal-message" rows={6} value={message} spellCheck autoFocus onChange={event => setMessage(event.target.value)} disabled={running} />
      {view.bump && <label className="proposal-bump" htmlFor="proposal-bump"><span>Version <span className="muted">— from your “Bump version” automation</span></span>
        <select id="proposal-bump" value={bump ?? 'none'} disabled={running} onChange={event => setBump(event.target.value)}>
          {BUMP_CHOICES.map(choice => <option key={choice} value={choice}>{bumpLabel(view.bump, choice)}</option>)}
        </select>
        {newVersions.length > 0 && <span className="proposal-bump-new" aria-live="polite">
          New version{newVersions.length === 1 ? '' : 's'}: {newVersions.map(({ path, version }) => <code key={path}>{path} {version}</code>)}
        </span>}
      </label>}
      <p className="muted">These commands will run, after your pre-commit automations:</p>
      <code className="confirm-command proposal-commands">{commands.map(line => <span key={line}>$ {line}</span>)}</code>
      {running && <p role="status" className="proposal-progress">{step ? `${step.name}: ${step.status}` : 'Committing…'}</p>}
      {failure && <pre className="proposal-failure" role="alert">{failure}</pre>}
      {failure ? <div className="dialog-actions"><Button className="primary" onClick={onClose}>Close</Button></div> : <div className="dialog-actions">
        <Button onClick={() => decide('cancel')} reason={busyReason}>Cancel</Button>
        <Button className={primary === 'commit' ? 'primary' : undefined} onClick={() => decide('commit')}
          reason={busyReason || (empty ? 'Write a commit message' : undefined)}>Commit</Button>
        <Button className={primary === 'commit-push' ? 'primary' : undefined} onClick={() => decide('commit-push')}
          reason={busyReason || pushReason || (empty ? 'Write a commit message' : undefined)}>Commit &amp; Push</Button>
      </div>}
    </div>
  </Dialog>;
}
