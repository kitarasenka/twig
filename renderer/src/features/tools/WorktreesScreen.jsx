import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bot, Copy, ExternalLink, FilePlus2, FolderGit2, GitCompare, GitMerge, Plus, RefreshCw, Scissors, Trash2, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import OperationNote from '../../ui/OperationNote.jsx';
import { relativeTime } from '../../ui/relative-time.js';
import DiffLines from '../diff/DiffLines.jsx';
import FileStatus from '../diff/FileStatus.jsx';
import { boardBadges, changesLine, compareCell, compareChoices, connectedLine, finishCommands, folderLabel, launchCommand, progressLine, squashReason,
  worktreeLine, worktreeRemoveCommand, worktreeRemoveReason } from './tools-view.js';

const shown = command => command.map(arg => (/[\s"'`$\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
const plural = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`;

/**
 * Every worktree of this repository, as a board for parallel work: each card
 * says what is not committed, how far its branch is from the base (the branch
 * of the main worktree) and when it last changed. Choosing a card shows
 * everything that worktree changed since its branch left the base — its
 * commits and its uncommitted files — without opening it as a tab. From there
 * its work comes back as one squashed commit on the base, and the worktree
 * and its branch go. An agent is started in a worktree by the person, from
 * the command the card copies; 🌱 Twig runs no agent itself.
 */
export default function WorktreesScreen({ repository, platform, busy, refreshKey = 0, onBack, onNew, onNewAgent, onOpen, onDialog, onWorkspace, onChanged, onConsole }) {
  const [board, setBoard] = useState({ base: null, worktrees: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [selected, setSelected] = useState(null);
  const [review, setReview] = useState(null);
  const [diff, setDiff] = useState(null);
  const [squash, setSquash] = useState(null);
  // Another worktree to hold this one against: two agents given the same task.
  const [compareWith, setCompareWith] = useState(null);
  const generation = useRef(0);
  const reviewRequest = useRef(0);
  const diffRequest = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const next = await window.twig.getWorktreeBoard(repository.id);
      if (epoch !== generation.current) return;
      setBoard(next); setError('');
      setSelected(current => (current && next.worktrees.some(entry => entry.path === current) ? current
        : (next.worktrees.find(entry => !entry.main && !entry.prunable) || next.worktrees[0])?.path ?? null));
    } catch (failure) { if (epoch === generation.current) setError(failure.message || 'Could not read the worktrees.'); }
    finally { if (epoch === generation.current) setLoading(false); }
  }, [repository.id]);
  useEffect(() => { void refresh(); const token = generation; return () => { token.current++; }; }, [refresh, refreshKey]);
  // An agent edits files without touching .git, so coming back to the window reads the board again;
  // an agent connecting or leaving over MCP does too.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const offAgents = window.twig.onMcpAgents(onFocus);
    return () => { window.removeEventListener('focus', onFocus); offAgents(); };
  }, [refresh]);

  const card = board.worktrees.find(entry => entry.path === selected) || null;
  const reviewable = Boolean(card && !card.main && !card.bare && !card.prunable);
  const loadReview = useCallback(async folder => {
    const epoch = ++reviewRequest.current;
    try {
      const next = await window.twig.getWorktreeReview(repository.id, folder);
      if (epoch === reviewRequest.current) setReview(next);
    } catch (failure) { if (epoch === reviewRequest.current) setReview({ folder, error: failure.message || 'Could not read what this worktree changed.' }); }
  }, [repository.id]);
  // Read again whenever the card's numbers moved: the agent committed or edited something.
  const cardKey = card ? `${card.path}:${card.head}:${card.changes?.files}:${card.changes?.insertions}:${card.changes?.deletions}:${card.lastActivity}` : '';
  useEffect(() => {
    if (!reviewable) { reviewRequest.current++; setReview(null); return; }
    void loadReview(card.path);
  }, [cardKey, reviewable, loadReview]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { diffRequest.current++; setDiff(null); setCompareWith(null); }, [selected]);
  const partner = compareWith ? board.worktrees.find(entry => entry.path === compareWith) || null : null;

  async function openDiff(file) {
    const epoch = ++diffRequest.current;
    setDiff({ path: file.path, loading: true });
    try {
      const result = await window.twig.getWorktreeFileDiff(repository.id, card.path, file.path, file.untracked);
      if (epoch === diffRequest.current) setDiff({ path: file.path, binary: file.binary, ...result });
    } catch (failure) { if (epoch === diffRequest.current) setDiff({ path: file.path, error: failure.message || 'Could not read this diff.' }); }
  }

  async function copyLaunch(entry) {
    const command = launchCommand(entry.path, platform);
    try { await window.twig.copyText(command); setNote(`Copied: ${command}. Paste it in a terminal to start an agent in this worktree.`); }
    catch { setNote({ text: 'Could not copy the command. Select it on the card and copy it.', failed: true }); }
  }

  async function run(action, done) {
    setWorking(true); setNote('');
    try { await done(await action()); }
    catch (failure) { setNote({ text: failure.message || 'That did not finish.', failed: true }); }
    finally { setWorking(false); void refresh(); }
  }
  function remove(entry, force) {
    void run(() => window.twig.removeWorktree(repository.id, entry.path, force), result => {
      if (result.ok) { setNote(`Worktree ${folderLabel(entry.path)} removed.`); onWorkspace(result.workspace); }
      else if (result.dirty && !force) confirmRemove(entry, true);
      else setNote({ text: result.message, failed: true });
    });
  }
  function confirmRemove(entry, force = false) {
    onDialog({
      type: 'confirm', title: `Remove worktree ${folderLabel(entry.path)}`, command: worktreeRemoveCommand(entry.path, force),
      consequence: force
        ? `${entry.path} has uncommitted or untracked files. Removing it anyway deletes them for good. ${entry.branch ? `The branch ${entry.branch} and its commits stay.` : ''}`
        : `The folder ${entry.path} is deleted. ${entry.branch ? `The branch ${entry.branch} and its commits stay in the repository.` : 'Its commits stay in the repository.'} Git refuses if it has uncommitted work.`,
      confirmLabel: force ? 'Remove and discard its changes' : 'Remove worktree',
      onConfirm: () => remove(entry, force)
    });
  }
  function confirmFinish(entry) {
    onDialog({
      type: 'confirm', title: `Remove ${folderLabel(entry.path)} and ${entry.branch}`, command: finishCommands(entry.path, entry.branch),
      consequence: `Its work is in ${board.base}, so the folder ${entry.path} and the branch ${entry.branch} go. Git refuses if the worktree has uncommitted files.`,
      confirmLabel: 'Remove worktree and branch',
      onConfirm: () => void run(() => window.twig.finishWorktree(repository.id, entry.path), result => {
        if (result.workspace) onWorkspace(result.workspace);
        if (result.ok) { setNote(`Worktree ${folderLabel(entry.path)} and branch ${result.branch} removed.`); onChanged?.(); }
        else setNote({ text: result.message, failed: true });
      })
    });
  }
  async function openSquash(entry) {
    setNote('');
    try { setSquash(await window.twig.planWorktreeSquash(repository.id, entry.path)); }
    catch (failure) { setNote({ text: failure.message || 'Could not plan the squash.', failed: true }); }
  }
  function doSquash(message) {
    const plan = squash;
    setSquash(null);
    void run(() => window.twig.squashWorktree(repository.id, plan.folder, { message, branchOid: plan.branchOid, baseOid: plan.baseOid }), result => {
      if (result.ok) {
        setNote(`${plan.branch} squashed into ${result.base} as ${result.oid.slice(0, 7)}. Undo takes the commit back.`);
        onChanged?.({ history: true });
      } else setNote({ text: result.message, failed: true });
    });
  }
  async function prune() {
    void run(() => window.twig.pruneWorktrees(repository.id), result => setNote(result.ok ? 'Worktrees with missing folders forgotten.' : { text: result.message, failed: true }));
  }

  const reason = busy || working ? 'Git is working' : undefined;
  const { base } = board;
  return <section className="tool-screen worktree-board" aria-label="Worktrees">
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>Back to history</Button>
      <div><FolderGit2 aria-hidden="true" /><strong>Worktrees</strong><span className="count">{board.worktrees.length}</span></div>
      <div className="tool-actions">
        {board.worktrees.some(entry => entry.prunable) && <Button icon={Scissors} reason={reason} onClick={() => void prune()}
          title="git worktree prune: forget worktrees whose folders are gone">Prune missing</Button>}
        <Button icon={Bot} className="primary" reason={reason} onClick={onNewAgent}>New agent worktree…</Button>
        <Button icon={Plus} reason={reason} onClick={() => onNew(null)}>New worktree…</Button>
        <Button icon={RefreshCw} reason={reason} onClick={() => void refresh()}>Refresh</Button>
      </div>
    </header>
    <p className="tool-intro muted">Each worktree is a checkout of this repository in its own folder, on its own branch. Give each agent one: it works there without touching yours, and its work comes back to {base || 'the base branch'} as one commit.</p>
    <OperationNote note={note} onConsole={onConsole} onDismiss={() => setNote('')} />
    {error && <p className="history-error" role="alert">{error}<button onClick={onConsole}>Show output</button></p>}
    {loading && <div className="loading-shell" aria-label="Loading worktrees">{Array.from({ length: 3 }, (_, index) => <div className="skeleton" key={index} />)}</div>}
    <div className="board-body">
      <ul className="board-list" aria-label="Worktrees">
        {board.worktrees.map(entry => <li key={entry.path}>
          <button type="button" className={entry.path === selected ? 'selected' : ''} aria-pressed={entry.path === selected} onClick={() => setSelected(entry.path)}>
            <strong>{folderLabel(entry.path)}{boardBadges(entry).map(badge => <span key={badge} className={`tool-badge${badge === 'Commit proposed' || badge === 'Done' ? ' strong' : ''}`}>{badge}</span>)}</strong>
            <span>{worktreeLine(entry)}</span>
            {progressLine(entry, base) && <span>{progressLine(entry, base)}</span>}
            {entry.changes && <small>{changesLine(entry.changes)}</small>}
            {entry.lastActivity && <small>Changed {relativeTime(entry.lastActivity / 1000)}</small>}
            {entry.connected && <small className="board-connected">{connectedLine(entry.connected, relativeTime)}</small>}
            {entry.prunable && <small className="warn">Folder missing: {entry.prunable}</small>}
          </button>
        </li>)}
      </ul>
      {card && <div className="board-detail" aria-label={`Worktree ${folderLabel(card.path)}`}>
        <div className="board-detail-head">
          <div>
            <strong>{folderLabel(card.path)}</strong>
            <code className="tool-path" title={card.path}>{card.path}</code>
          </div>
          <div className="tool-actions">
            {!card.main && !card.prunable && <Button icon={Copy} onClick={() => void copyLaunch(card)} title={launchCommand(card.path, platform)}>Copy command</Button>}
            {!card.main && <Button icon={GitMerge} className="primary" reason={squashReason(card, base, Boolean(reason))} onClick={() => void openSquash(card)}>Squash into {base || 'base'}…</Button>}
            <Button icon={ExternalLink} reason={card.current ? 'This worktree is open in this tab' : card.prunable ? 'Its folder is gone' : card.bare ? 'A bare repository has no files to show' : undefined}
              onClick={() => void onOpen(card.path)}>Open as tab</Button>
            {card.integrated
              ? <Button icon={Trash2} className="danger quiet" reason={worktreeRemoveReason(card, Boolean(reason))} onClick={() => confirmFinish(card)}>Remove worktree and branch…</Button>
              : <Button icon={Trash2} className="danger quiet" reason={worktreeRemoveReason(card, Boolean(reason))} onClick={() => confirmRemove(card)}>Remove…</Button>}
          </div>
        </div>
        {!card.main && !card.prunable && <p className="board-launch">
          {card.connected ? <span className="board-connected">{connectedLine(card.connected, relativeTime)}. </span> : null}
          <span className="muted">Start {card.connected ? 'another' : 'an'} agent here:</span> <code>{launchCommand(card.path, platform)}</code></p>}
        {reviewable && compareChoices(board.worktrees, card.path).length > 0 && <div className="board-compare-pick">
          <label htmlFor="board-compare"><GitCompare aria-hidden="true" />Compare with</label>
          <select id="board-compare" value={compareWith || ''} onChange={event => setCompareWith(event.target.value || null)}>
            <option value="">Nothing — show what it changed</option>
            {compareChoices(board.worktrees, card.path).map(entry => <option key={entry.path} value={entry.path}>{folderLabel(entry.path)}{entry.branch ? ` (${entry.branch})` : ''}</option>)}
          </select>
          {compareWith && <Button icon={X} onClick={() => setCompareWith(null)}>Stop comparing</Button>}
        </div>}
        {card.main && <p className="empty-inline">The main worktree holds {base || 'the base branch'}. Its uncommitted changes are on the history screen; other worktrees are compared with it.</p>}
        {reviewable && partner && <Compare repositoryId={repository.id} left={card} right={partner} base={base} />}
        {reviewable && !partner && <Review review={review?.folder === card.path ? review : null} diff={diff} base={base} onFile={file => void openDiff(file)} />}
      </div>}
    </div>
    {squash && <SquashDialog plan={squash} onSquash={doSquash} onClose={() => setSquash(null)} />}
  </section>;
}

/** What one worktree changed since its branch left the base: its commits, then every file. */
function Review({ review, diff, base, onFile }) {
  if (!review) return <div className="loading-shell" aria-label="Reading what this worktree changed"><div className="skeleton" /></div>;
  if (review.error) return <p role="alert" className="empty-inline">{review.error}</p>;
  const committed = review.commits.length;
  return <div className="board-review">
    <p className="board-summary">{review.fork ? `Since it left ${base}` : 'Not committed yet'}: {plural(committed, 'commit')}, {plural(review.uncommitted, 'file')} not committed — {plural(review.files.length, 'file')} changed in all.</p>
    {committed > 0 && <ul className="board-commits" aria-label="Commits in this worktree">
      {review.commits.map(commit => <li key={commit.oid}><code>{commit.oid.slice(0, 7)}</code><span>{commit.subject}</span></li>)}
    </ul>}
    <ul className="stash-files" aria-label="Files this worktree changed">
      {review.files.length === 0 && <li className="empty-inline">Nothing changed yet.</li>}
      {review.files.map(file => <li key={`${file.path}:${file.untracked}`}>
        <button type="button" className={diff?.path === file.path ? 'selected' : ''} aria-pressed={diff?.path === file.path} onClick={() => onFile(file)}>
          <FileStatus status={file.status} />
          <span>{file.path}</span>
          {file.untracked ? <small><FilePlus2 aria-hidden="true" />untracked</small>
            : file.insertions !== null && <small>+{file.insertions} −{file.deletions}</small>}
        </button>
      </li>)}
    </ul>
    {diff && <div className="diff-view" aria-label={`Diff of ${diff.path}`}>
      {diff.loading ? <div className="loading-shell"><div className="skeleton" /></div>
        : diff.error ? <p role="alert" className="empty-inline">{diff.error}</p>
          : diff.note ? <p className="empty-inline">{diff.note}</p>
            : diff.binary ? <p className="empty-inline">Binary file. A text diff is unavailable.</p>
              : <DiffLines patch={diff.patch} path={diff.path} label={`Diff of ${diff.path}`} />}
    </div>}
  </div>;
}

/**
 * Two worktrees side by side: what each changed since it left the base, file
 * by file, and one file of the two as a diff — − lines are the left
 * worktree's, + lines the right one's, uncommitted work included. Read again
 * when either side's numbers move.
 */
function Compare({ repositoryId, left, right, base }) {
  const [result, setResult] = useState(null);
  const [diff, setDiff] = useState(null);
  const request = useRef(0);
  const diffRequest = useRef(0);
  const key = [left, right].map(entry => `${entry.path}:${entry.head}:${entry.changes?.files}:${entry.changes?.insertions}:${entry.changes?.deletions}:${entry.lastActivity}`).join('|');
  useEffect(() => {
    const epoch = ++request.current;
    setResult(current => (current?.left.folder === left.path && current?.right.folder === right.path ? current : null));
    window.twig.compareWorktrees(repositoryId, left.path, right.path)
      .then(next => { if (epoch === request.current) setResult(next); })
      .catch(failure => { if (epoch === request.current) setResult({ error: failure.message || 'Could not compare the two worktrees.' }); });
  }, [repositoryId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { diffRequest.current++; setDiff(null); }, [left.path, right.path]);
  async function open(file) {
    const epoch = ++diffRequest.current;
    setDiff({ path: file.path, loading: true });
    try {
      const next = await window.twig.getWorktreeCompareDiff(repositoryId, left.path, right.path, file.path);
      if (epoch === diffRequest.current) setDiff({ path: file.path, ...next });
    } catch (failure) { if (epoch === diffRequest.current) setDiff({ path: file.path, error: failure.message || 'Could not compare this file.' }); }
  }
  if (!result) return <div className="loading-shell" aria-label="Comparing the two worktrees"><div className="skeleton" /></div>;
  if (result.error) return <p role="alert" className="empty-inline">{result.error}</p>;
  const names = [folderLabel(left.path), folderLabel(right.path)];
  const side = summary => `${plural(summary.commits, 'commit')}, ${plural(summary.uncommitted, 'file')} not committed, ${plural(summary.files, 'file')} changed`;
  return <div className="board-review board-compare">
    <p className="board-summary"><strong>{names[0]}</strong>: {side(result.left)} · <strong>{names[1]}</strong>: {side(result.right)}{base ? `, each since it left ${base}` : ''}.</p>
    <p className="board-summary muted">Pick the one to keep, squash it into {base || 'the base'}, then remove the other. In a file’s diff, − lines are {names[0]}’s and + lines are {names[1]}’s.</p>
    <table className="board-compare-files" aria-label={`Files changed in ${names[0]} or ${names[1]}`}>
      <thead><tr><th scope="col">File</th><th scope="col">{names[0]}</th><th scope="col">{names[1]}</th></tr></thead>
      <tbody>
        {result.files.length === 0 && <tr><td colSpan={3} className="empty-inline">Neither changed anything yet.</td></tr>}
        {result.files.map(file => <tr key={file.path} className={diff?.path === file.path ? 'selected' : ''}>
          <th scope="row"><button type="button" aria-pressed={diff?.path === file.path} onClick={() => void open(file)}>{file.path}</button></th>
          <td className={file.left ? '' : 'muted'}>{compareCell(file.left)}</td>
          <td className={file.right ? '' : 'muted'}>{compareCell(file.right)}</td>
        </tr>)}
      </tbody>
    </table>
    {diff && <div className="diff-view" aria-label={`${diff.path}: ${names[0]} against ${names[1]}`}>
      {diff.loading ? <div className="loading-shell"><div className="skeleton" /></div>
        : diff.error ? <p role="alert" className="empty-inline">{diff.error}</p>
          : diff.note ? <p className="empty-inline">{diff.note}</p>
            : diff.same ? <p className="empty-inline">{diff.path} is the same in both.</p>
              : diff.binary ? <p className="empty-inline">Binary file, different in the two. A text diff is unavailable.</p>
                : <DiffLines patch={diff.patch} path={diff.path} label={`${diff.path}: ${names[0]} against ${names[1]}`} />}
    </div>}
  </div>;
}

/**
 * The squash, before it runs: the commits that become one, the message
 * (written from them, the person's to edit), what is left out, and the exact
 * commands, run in the base worktree.
 */
function SquashDialog({ plan, onSquash, onClose }) {
  const [message, setMessage] = useState(plan.message);
  const reason = plan.problem || (message.trim() ? undefined : 'Write a commit message');
  return <Dialog title={`Squash ${plan.branch} into ${plan.base}`} wide onClose={onClose}>
    <form className="squash-dialog" onSubmit={event => { event.preventDefault(); if (!reason) onSquash(message); }}>
      <p className="muted">{plural(plan.commits.length, 'commit')} of {plan.branch} become one commit on {plan.base}. The worktree and its branch stay until you remove them.</p>
      {plan.problem && <p role="alert" className="warn">{plan.problem}</p>}
      {plan.warnings.map(warning => <p key={warning} className="warn">{warning}</p>)}
      {plan.commits.length > 0 && <ul className="board-commits" aria-label="Commits to squash">
        {plan.commits.map(commit => <li key={commit.oid}><code>{commit.oid.slice(0, 7)}</code><span>{commit.subject}</span></li>)}
      </ul>}
      <label htmlFor="squash-message">Message <span className="muted">— written from the commits, yours to edit</span></label>
      <textarea id="squash-message" rows={7} value={message} spellCheck={false} data-autofocus onChange={event => setMessage(event.target.value)} />
      {plan.commands.length > 0 && <>
        <p className="muted">These commands will run in {plan.basePath}, the message on standard input:</p>
        {plan.commands.map((argv, index) => <code key={index} className="confirm-command">$ git {shown(argv)}</code>)}
        <p className="muted">If Git stops on a conflict or a hook refuses the commit, {plan.base} is put back as it was (git reset --merge). Undo in {plan.base} takes the commit back and leaves its changes staged.</p>
      </>}
      <div className="dialog-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" className="primary" reason={reason}>Squash into {plan.base}</Button>
      </div>
    </form>
  </Dialog>;
}
