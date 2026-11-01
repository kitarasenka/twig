import { useEffect, useMemo, useState } from 'react';
import { FolderGit2, FolderOpen } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { freeBranches, worktreeAddCommand } from './tools-view.js';
import { failureText, t } from '../../i18n/i18n.js';

const shown = command => command.map(arg => (/[\s"'`$\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
const INVALID = /[\s~^:?*[\\]|\.\.|^[-/.]|\.lock$|\/$/;

/**
 * "Open a branch in a new worktree": an existing branch no worktree has
 * checked out, or a new branch at the current commit, in its own folder —
 * next to the repository unless the person picks another place. Main plans
 * the folder and holds it by a token, so the command shown is the command run.
 */
export default function WorktreeDialog({ repository, refs, headOid, headBranch, initialBranch = null, agent = false, onCreate, onClose }) {
  const [worktrees, setWorktrees] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState(initialBranch && !agent ? 'existing' : 'new');
  const [branch, setBranch] = useState(initialBranch || '');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState(null);
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    let alive = true;
    window.twig.getWorktrees(repository.id).then(list => { if (alive) setWorktrees(list); })
      .catch(failure => { if (alive) setError(failureText(failure, t('Could not read the worktrees.'))); });
    return () => { alive = false; };
  }, [repository.id]);
  const free = useMemo(() => (worktrees ? freeBranches(refs, worktrees) : []), [refs, worktrees]);
  const busyElsewhere = worktrees && initialBranch && !free.includes(initialBranch)
    ? worktrees.find(entry => entry.branch === initialBranch) : null;
  useEffect(() => {
    if (mode === 'existing' && !branch && free[0]) setBranch(free[0]);
  }, [mode, branch, free]);
  const target = mode === 'existing' ? branch : name.trim();
  const invalid = mode === 'new' && Boolean(target) && INVALID.test(target);
  const branchName = agent ? (target ? `agent/${target}` : '') : target;
  const exists = mode === 'new' && refs.some(ref => ref.type === 'local' && ref.name === branchName);
  useEffect(() => {
    if (chosen || !target || invalid) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      window.twig.planWorktree(repository.id, target, agent ? 'agent' : 'next').then(next => { if (alive) setPlan(next); })
        .catch(failure => { if (alive) setError(failureText(failure, t('Could not plan the folder.'))); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [repository.id, target, invalid, chosen, agent]);
  async function chooseFolder() {
    try {
      const next = await window.twig.planWorktree(repository.id, target, 'choose');
      if (next) { setPlan(next); setChosen(true); }
    } catch (failure) { setError(failureText(failure, t('Could not use that folder.'))); }
  }
  const create = mode === 'new';
  const reason = !worktrees ? t('Reading the worktrees…') : !target ? (agent ? t('Enter a task name') : create ? t('Enter a branch name') : t('No branch is free to check out'))
    : invalid ? t('This name is not valid') : exists ? (agent ? t`The branch ${branchName} exists; choose another name` : t('A branch with this name exists; choose it under Existing branch'))
      : create && !headOid ? t('There is no commit to start from yet') : !plan || (agent && plan.branch !== branchName) ? t('Planning the folder…') : undefined;
  const start = headBranch || 'HEAD';
  const command = plan && target ? worktreeAddCommand({ path: plan.path, branch: plan.branch || branchName, create, startPoint: headOid }) : null;
  if (agent) {
    return <Dialog title={t('New agent worktree')} onClose={onClose}>
      <form className="worktree-dialog" onSubmit={event => { event.preventDefault(); if (reason) return; onClose(); onCreate({ token: plan.token, branch: plan.branch, create: true, startPoint: headOid, agent: true }); }}>
        <p className="muted">{headOid
          ? t`A checkout of its own for one agent: a new branch from ${start} (${headOid.slice(0, 7)}) in this repository’s .claude/worktrees folder, where claude --worktree puts its own. It stays on the board; copy its command there to start the agent.`
          : t`A checkout of its own for one agent: a new branch from ${start} (no commit) in this repository’s .claude/worktrees folder, where claude --worktree puts its own. It stays on the board; copy its command there to start the agent.`}</p>
        {error && <p role="alert" className="warn">{error}</p>}
        <label htmlFor="worktree-agent-name">{t('Task name')}
          <input id="worktree-agent-name" value={name} autoComplete="off" spellCheck={false} placeholder="fix-login" onChange={event => setName(event.target.value)} /></label>
        <div className="worktree-folder"><span><FolderGit2 aria-hidden="true" /><code>{plan?.path || '…'}</code></span></div>
        {command && <><p className="muted">{t('This command will run:')}</p><code className="confirm-command">$ git {shown(command)}</code>
          <p className="muted">{t('If the main checkout does not ignore .claude/worktrees/ yet, 🌱 Twig adds it to .git/info/exclude, a local file Git never commits.')}</p></>}
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>{t('Cancel')}</Button>
          <Button type="submit" className="primary" reason={reason}>{t('Create')}</Button>
        </div>
      </form>
    </Dialog>;
  }
  return <Dialog title={t('New worktree')} onClose={onClose}>
    <form className="worktree-dialog" onSubmit={event => { event.preventDefault(); if (reason) return; onClose(); onCreate({ token: plan.token, branch: target, create, startPoint: create ? headOid : null }); }}>
      <p className="muted">{t('A second checkout of this repository in its own folder, opened as its own tab. The work in progress here stays as it is.')}</p>
      {error && <p role="alert" className="warn">{error}</p>}
      {busyElsewhere && <p role="status" className="warn">{t`${initialBranch} is already checked out in ${busyElsewhere.path}. A branch can be checked out in one worktree at a time.`}</p>}
      <div className="segmented" role="group" aria-label={t('Branch for the worktree')}>
        <button type="button" aria-pressed={mode === 'existing'} onClick={() => { setMode('existing'); setChosen(false); }}>{t('Existing branch')}</button>
        <button type="button" aria-pressed={mode === 'new'} onClick={() => { setMode('new'); setChosen(false); }}>{t('New branch')}</button>
      </div>
      {mode === 'existing'
        ? <label htmlFor="worktree-branch">{t('Branch')}<select id="worktree-branch" value={branch} onChange={event => { setBranch(event.target.value); setChosen(false); }}>
          {free.length === 0 && <option value="">{t('No branch is free — each is checked out somewhere')}</option>}
          {free.map(item => <option key={item} value={item}>{item}</option>)}
        </select></label>
        : <label htmlFor="worktree-new-branch">{headOid ? t`New branch name, starting at ${start} (${headOid.slice(0, 7)})` : t`New branch name, starting at ${start} (no commit)`}
          <input id="worktree-new-branch" value={name} autoComplete="off" spellCheck={false} placeholder="hotfix/login" onChange={event => { setName(event.target.value); setChosen(false); }} /></label>}
      <div className="worktree-folder"><span><FolderGit2 aria-hidden="true" /><code>{plan?.path || '…'}</code></span>
        <Button type="button" icon={FolderOpen} reason={!target || invalid ? t('Choose the branch first') : undefined} onClick={() => void chooseFolder()}>{t('Choose another folder…')}</Button></div>
      {command && <><p className="muted">{t('This command will run:')}</p><code className="confirm-command">$ git {shown(command)}</code></>}
      <div className="dialog-actions">
        <Button type="button" onClick={onClose}>{t('Cancel')}</Button>
        <Button type="submit" className="primary" reason={reason}>{t('Create and open')}</Button>
      </div>
    </form>
  </Dialog>;
}
