import { useEffect, useMemo, useState } from 'react';
import { FolderGit2, FolderOpen } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { freeBranches, worktreeAddCommand } from './tools-view.js';

const shown = command => command.map(arg => (/[\s"'`$\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
const INVALID = /[\s~^:?*[\\]|\.\.|^[-/.]|\.lock$|\/$/;

/**
 * "Open a branch in a new worktree": an existing branch no worktree has
 * checked out, or a new branch at the current commit, in its own folder —
 * next to the repository unless the person picks another place. Main plans
 * the folder and holds it by a token, so the command shown is the command run.
 */
export default function WorktreeDialog({ repository, refs, headOid, headBranch, initialBranch = null, onCreate, onClose }) {
  const [worktrees, setWorktrees] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState(initialBranch ? 'existing' : 'new');
  const [branch, setBranch] = useState(initialBranch || '');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState(null);
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    let alive = true;
    window.twig.getWorktrees(repository.id).then(list => { if (alive) setWorktrees(list); })
      .catch(failure => { if (alive) setError(failure.message || 'Could not read the worktrees.'); });
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
  const exists = mode === 'new' && refs.some(ref => ref.type === 'local' && ref.name === target);
  useEffect(() => {
    if (chosen || !target || invalid) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      window.twig.planWorktree(repository.id, target, false).then(next => { if (alive) setPlan(next); })
        .catch(failure => { if (alive) setError(failure.message || 'Could not plan the folder.'); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [repository.id, target, invalid, chosen]);
  async function chooseFolder() {
    try {
      const next = await window.twig.planWorktree(repository.id, target, true);
      if (next) { setPlan(next); setChosen(true); }
    } catch (failure) { setError(failure.message || 'Could not use that folder.'); }
  }
  const create = mode === 'new';
  const reason = !worktrees ? 'Reading the worktrees…' : !target ? (create ? 'Enter a branch name' : 'No branch is free to check out')
    : invalid ? 'This name is not valid' : exists ? 'A branch with this name exists; choose it under Existing branch'
      : create && !headOid ? 'There is no commit to start from yet' : !plan ? 'Planning the folder…' : undefined;
  const command = plan && target ? worktreeAddCommand({ path: plan.path, branch: target, create, startPoint: headOid }) : null;
  return <Dialog title="New worktree" onClose={onClose}>
    <form className="worktree-dialog" onSubmit={event => { event.preventDefault(); if (reason) return; onClose(); onCreate({ token: plan.token, branch: target, create, startPoint: create ? headOid : null }); }}>
      <p className="muted">A second checkout of this repository in its own folder, opened as its own tab. The work in progress here stays as it is.</p>
      {error && <p role="alert" className="warn">{error}</p>}
      {busyElsewhere && <p role="status" className="warn">{initialBranch} is already checked out in {busyElsewhere.path}. A branch can be checked out in one worktree at a time.</p>}
      <div className="segmented" role="group" aria-label="Branch for the worktree">
        <button type="button" aria-pressed={mode === 'existing'} onClick={() => { setMode('existing'); setChosen(false); }}>Existing branch</button>
        <button type="button" aria-pressed={mode === 'new'} onClick={() => { setMode('new'); setChosen(false); }}>New branch</button>
      </div>
      {mode === 'existing'
        ? <label htmlFor="worktree-branch">Branch<select id="worktree-branch" value={branch} onChange={event => { setBranch(event.target.value); setChosen(false); }}>
          {free.length === 0 && <option value="">No branch is free — each is checked out somewhere</option>}
          {free.map(item => <option key={item} value={item}>{item}</option>)}
        </select></label>
        : <label htmlFor="worktree-new-branch">New branch name, starting at {headBranch || 'HEAD'} ({headOid ? headOid.slice(0, 7) : 'no commit'})
          <input id="worktree-new-branch" value={name} autoComplete="off" spellCheck={false} placeholder="hotfix/login" onChange={event => { setName(event.target.value); setChosen(false); }} /></label>}
      <div className="worktree-folder"><span><FolderGit2 aria-hidden="true" /><code>{plan?.path || '…'}</code></span>
        <Button type="button" icon={FolderOpen} reason={!target || invalid ? 'Choose the branch first' : undefined} onClick={() => void chooseFolder()}>Choose another folder…</Button></div>
      {command && <><p className="muted">This command will run:</p><code className="confirm-command">$ git {shown(command)}</code></>}
      <div className="dialog-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" className="primary" reason={reason}>Create and open</Button>
      </div>
    </form>
  </Dialog>;
}
