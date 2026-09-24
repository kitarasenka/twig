import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, GitBranch, Globe, Link2, Pencil, Search, ShieldCheck, Tag, Trash2, Upload } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { pushRefCommand, splitRemoteRef } from './remote-ref.js';
import { TAG_SORTS, readTagSort, sortTags, writeTagSort } from './tag-sort.js';

const TABS = [['local', 'Branches', GitBranch], ['remote', 'Remote branches', Globe], ['tag', 'Tags', Tag]];
const tagDate = time => new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * What a tag says beyond its name. An annotated tag has a tagger, a date and a
 * message of its own; a lightweight one is only a name on a commit, and says
 * so rather than borrowing the commit's message.
 */
function TagSummary({ detail }) {
  if (!detail) return null;
  if (!detail.annotated) return <p className="refs-tag-note muted">Lightweight tag — a name on the commit, without a message of its own.</p>;
  return <div className="refs-tag-note">
    <p className="refs-tag-subject">{detail.subject || <span className="muted">(empty message)</span>}</p>
    {detail.body && <details className="refs-tag-body"><summary>Full message</summary><pre>{detail.body}</pre></details>}
  </div>;
}

/** Picks the upstream for a branch out of the remote-tracking refs the repository has. */
export function UpstreamDialog({ branch, current, candidates, onConfirm, onClose }) {
  const [value, setValue] = useState(current || '');
  return <Dialog title={`Upstream for ${branch}`} onClose={onClose}>
    <form className="name-dialog" onSubmit={event => { event.preventDefault(); onClose(); onConfirm(value || null); }}>
      <label htmlFor="upstream-ref">Track this remote-tracking branch</label>
      <select id="upstream-ref" value={value} onChange={event => setValue(event.target.value)}>
        <option value="">No upstream</option>
        {candidates.map(ref => <option key={ref} value={ref}>{ref}</option>)}
      </select>
      <p className="muted">Pull and push read the upstream to know what to compare against; without one the toolbar cannot show how far ahead or behind you are.</p>
      <div className="dialog-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" className="primary">{value ? 'Track it' : 'Remove upstream'}</Button>
      </div>
    </form>
  </Dialog>;
}

/**
 * Branches and tags as a screen rather than a sidebar list: §8.6 asks for a
 * list with search, and every action that belongs to a ref — checkout, rename,
 * upstream, delete, publish — needs a row it can sit on.
 *
 * Deleting a merged branch runs `branch -d` straight away, because Git itself
 * refuses it while anything would be lost; only the escalation to `-D` and
 * everything that touches a remote go through the §6.5 dialog.
 */
export default function RefsScreen({ repository, refs, headBranch, busy, onBack, onPerform, onDialog, onConsole }) {
  const [type, setType] = useState('local');
  const [filter, setFilter] = useState('');
  const [remotes, setRemotes] = useState([]);
  const [remote, setRemote] = useState('');
  const [notice, setNotice] = useState('');
  const [unmerged, setUnmerged] = useState(null);
  const [upstreamFor, setUpstreamFor] = useState(null);
  const [tagSort, setTagSort] = useState(() => readTagSort(window.localStorage));
  const [tagDetails, setTagDetails] = useState(null);
  const [tagError, setTagError] = useState('');

  useEffect(() => {
    let alive = true;
    window.twig.getRemotes(repository.id)
      .then(list => { if (!alive) return; setRemotes(list); setRemote(current => current || list[0]?.name || ''); })
      .catch(() => { if (alive) setRemotes([]); });
    return () => { alive = false; };
  }, [repository.id]);

  // Tag messages are read only while the Tags tab is open, and again whenever
  // the refs change (a tag created, deleted or fetched).
  const showingTags = type === 'tag';
  useEffect(() => {
    if (!showingTags) return undefined;
    let alive = true;
    window.twig.getTagDetails(repository.id)
      .then(list => { if (alive) { setTagDetails(new Map(list.map(tag => [tag.fullName, tag]))); setTagError(''); } })
      .catch(() => { if (alive) { setTagDetails(new Map()); setTagError('Could not read the tag messages.'); } });
    return () => { alive = false; };
  }, [repository.id, refs, showingTags]);

  const remoteNames = useMemo(() => remotes.map(item => item.name), [remotes]);
  const upstreamCandidates = useMemo(() => refs.filter(ref => ref.type === 'remote').map(ref => ref.name), [refs]);
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = ref => {
      if (!needle || ref.name.toLowerCase().includes(needle)) return true;
      const detail = ref.type === 'tag' ? tagDetails?.get(ref.fullName) : null;
      return Boolean(detail?.annotated && `${detail.subject}\n${detail.body}`.toLowerCase().includes(needle));
    };
    const list = refs.filter(ref => ref.type === type && matches(ref));
    if (type !== 'tag') return list;
    return sortTags(list.map(ref => ({ ...ref, date: tagDetails?.get(ref.fullName)?.date ?? null })), tagSort);
  }, [refs, type, filter, tagDetails, tagSort]);

  const run = useCallback(async (action, success) => {
    setNotice(''); setUnmerged(null);
    const result = await onPerform(action, success);
    return result;
  }, [onPerform]);

  async function deleteBranch(name) {
    const result = await run(() => window.twig.deleteBranch(repository.id, name, false), `Branch ${name} deleted.`);
    // `-d` is refused whenever anything would be lost, so a refusal is the one
    // moment where offering `-D` is honest instead of reckless.
    if (result && result.ok === false) setUnmerged(name);
  }

  function forceDelete(name) {
    onDialog({
      type: 'confirm', title: `Delete ${name} without checking`, command: ['branch', '-D', '--', name],
      consequence: `Git refused to delete ${name} because it holds commits that are on no other branch. Deleting it anyway leaves those commits reachable only through the reflog, which expires.`,
      confirmLabel: 'Delete the branch anyway',
      onConfirm: () => void run(() => window.twig.deleteBranch(repository.id, name, true), `Branch ${name} force-deleted.`)
    });
  }

  function rename(name) {
    onDialog({
      type: 'name', title: `Rename ${name}`, label: 'New branch name', placeholder: name, initialValue: name, confirmLabel: 'Rename branch',
      onConfirm: ({ name: next }) => void run(() => window.twig.renameBranch(repository.id, name, next), `Branch ${name} renamed to ${next}.`)
    });
  }

  function checkoutRemote(ref) {
    const short = ref.name.slice(ref.name.indexOf('/') + 1);
    onDialog({
      type: 'name', title: `Check out ${ref.name}`, label: 'Local branch name', placeholder: short,
      confirmLabel: 'Create and check out', extra: null,
      onConfirm: ({ name }) => void run(() => window.twig.createBranch(repository.id, name, ref.target, true), `Checked out ${name}.`)
    });
  }

  function pushTag(ref, remove) {
    if (!remote) { setNotice('This repository has no remote configured.'); return; }
    const target = `refs/tags/${ref.name}`;
    onDialog({
      type: 'confirm', title: `${remove ? 'Delete' : 'Publish'} ${ref.name} on ${remote}`,
      command: pushRefCommand({ remote, ref: target, remove }),
      consequence: remove
        ? `The tag disappears from ${remote} for everyone. Clones that already fetched it keep their copy until they prune.`
        : `The tag becomes visible to everyone who fetches ${remote}. A published tag is not meant to be moved afterwards.`,
      confirmLabel: remove ? `Delete on ${remote}` : `Push to ${remote}`,
      onConfirm: () => void run(() => window.twig.pushRef(repository.id, remote, target, remove),
        `${ref.name} ${remove ? 'deleted on' : 'pushed to'} ${remote}.`)
    });
  }

  function deleteRemoteBranch(ref) {
    const split = splitRemoteRef(ref.fullName, remoteNames);
    if (!split) { setNotice('The remote of this branch is no longer configured. Reload the remotes first.'); return; }
    onDialog({
      type: 'confirm', title: `Delete ${split.branch} on ${split.remote}`,
      command: pushRefCommand({ remote: split.remote, ref: split.ref, remove: true }),
      consequence: `The branch is removed on ${split.remote} for everyone. Your local branches are untouched, and anyone who already fetched it keeps their copy until they prune.`,
      confirmLabel: `Delete on ${split.remote}`,
      onConfirm: () => void run(() => window.twig.pushRef(repository.id, split.remote, split.ref, true),
        `${ref.name} deleted on ${split.remote}.`)
    });
  }

  function deleteTag(ref) {
    onDialog({
      type: 'confirm', title: `Delete tag ${ref.name}`, command: ['tag', '-d', '--', ref.name],
      consequence: 'The tag is removed locally. If it was already pushed, it stays on the remote until it is deleted there too.',
      confirmLabel: 'Delete tag',
      onConfirm: () => void run(() => window.twig.deleteTag(repository.id, ref.name), `Tag ${ref.name} deleted.`)
    });
  }

  const reason = busy ? 'Git is working' : undefined;
  return <section className="refs-screen" aria-label="Branches and tags">
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>Back to history</Button>
      <div className="refs-tabs" role="tablist" aria-label="Reference kind">
        {TABS.map(([value, label, Icon]) => <button key={value} role="tab" type="button" aria-selected={type === value}
          className={type === value ? 'selected' : ''} onClick={() => setType(value)}>
          <Icon aria-hidden="true" />{label}<span className="count">{refs.filter(ref => ref.type === value).length}</span>
        </button>)}
      </div>
    </header>
    <div className="refs-toolbar">
      <label className="refs-search"><Search aria-hidden="true" />
        <input value={filter} placeholder={type === 'tag' ? 'Search by name or message' : 'Search by name'} aria-label="Search branches and tags" autoComplete="off"
          spellCheck={false} onChange={event => setFilter(event.target.value)} /></label>
      {type === 'tag' && <label className="refs-remote">Sort
        <select aria-label="Sort tags" value={tagSort} onChange={event => { setTagSort(event.target.value); writeTagSort(window.localStorage, event.target.value); }}>
          {TAG_SORTS.map(sort => <option key={sort.id} value={sort.id}>{sort.label}</option>)}
        </select></label>}
      {type === 'tag' && remotes.length > 0 && <label className="refs-remote">Remote
        <select value={remote} onChange={event => setRemote(event.target.value)}>
          {remotes.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select></label>}
    </div>
    {type === 'tag' && tagError && <p className="operation-note" role="alert">{tagError}<button onClick={onConsole}>Show output</button></p>}
    {notice && <p className="operation-note" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss">×</button></p>}
    {unmerged && <p className="operation-note" role="alert">
      <span>Git refused to delete {unmerged}: it is not fully merged.</span>
      <Button className="danger" onClick={() => forceDelete(unmerged)}>Delete anyway</Button>
      <button onClick={() => { setUnmerged(null); onConsole(); }} aria-label="Show output">Show output</button>
    </p>}
    <div className="refs-rows" role="list">
      {rows.length === 0 && <p className="empty-inline">No {TABS.find(([value]) => value === type)[1].toLowerCase()} match this search.</p>}
      {rows.map(ref => { const tag = ref.type === 'tag' ? tagDetails?.get(ref.fullName) : null; return <div className="refs-row" role="listitem" key={ref.fullName}>
        <div className="refs-name">
          <strong>{ref.name}{ref.type === 'local' && ref.name === headBranch && <span className="refs-head">current</span>}
            {tag && <span className="refs-kind">{tag.annotated ? 'annotated' : 'lightweight'}</span>}
            {tag?.signed && <span className="refs-kind" title="The tag object carries a signature. Verify it with git tag -v."><ShieldCheck aria-hidden="true" />signed</span>}</strong>
          <small>
            <code>{ref.target.slice(0, 7)}</code>
            {tag?.tagger && <> · {tag.tagger.name}</>}
            {tag && Number.isFinite(tag.date) && <> · <time dateTime={new Date(tag.date).toISOString()} title={new Date(tag.date).toLocaleString('en-GB')}>{tagDate(tag.date)}</time></>}
            {ref.upstream && <> · tracks {ref.upstream}</>}
            {(ref.ahead > 0 || ref.behind > 0) && <> · ↑{ref.ahead} ↓{ref.behind}</>}
            {ref.type === 'local' && !ref.upstream && <> · no upstream</>}
          </small>
          {ref.type === 'tag' && <TagSummary detail={tag} />}
        </div>
        <div className="refs-actions">
          {ref.type === 'local' && <>
            <Button reason={reason || (ref.name === headBranch ? 'Already checked out' : undefined)}
              onClick={() => void run(() => window.twig.checkoutRef(repository.id, ref.name, false), `Checked out ${ref.name}.`)}>Check out</Button>
            <Button icon={Pencil} reason={reason} title="Rename this branch" aria-label={`Rename ${ref.name}`} onClick={() => rename(ref.name)} />
            <Button icon={Link2} reason={reason} title="Choose the upstream branch" aria-label={`Upstream for ${ref.name}`} onClick={() => setUpstreamFor(ref)} />
            <Button icon={Trash2} className="danger quiet" title="Delete this branch" aria-label={`Delete ${ref.name}`}
              reason={reason || (ref.name === headBranch ? 'A checked-out branch cannot be deleted' : undefined)}
              onClick={() => void deleteBranch(ref.name)} />
          </>}
          {ref.type === 'remote' && <>
            <Button reason={reason} onClick={() => checkoutRemote(ref)}>Check out as new branch</Button>
            <Button icon={Trash2} className="danger quiet" reason={reason} title="Delete this branch on its remote" aria-label={`Delete ${ref.name} on its remote`}
              onClick={() => deleteRemoteBranch(ref)} />
          </>}
          {ref.type === 'tag' && <>
            <Button icon={Upload} reason={reason || (remote ? undefined : 'No remote is configured')}
              onClick={() => pushTag(ref, false)}>Push</Button>
            <Button icon={Trash2} className="danger quiet" reason={reason} title="Delete this tag" aria-label={`Delete tag ${ref.name}`} onClick={() => deleteTag(ref)} />
            <Button className="danger quiet" reason={reason || (remote ? undefined : 'No remote is configured')}
              onClick={() => pushTag(ref, true)}>Delete on remote</Button>
          </>}
        </div>
      </div>; })}
    </div>
    {upstreamFor && <UpstreamDialog branch={upstreamFor.name} current={upstreamFor.upstream} candidates={upstreamCandidates}
      onClose={() => setUpstreamFor(null)}
      onConfirm={value => void run(() => window.twig.setUpstream(repository.id, upstreamFor.name, value),
        value ? `${upstreamFor.name} now tracks ${value}.` : `${upstreamFor.name} no longer tracks anything.`)} />}
  </section>;
}
