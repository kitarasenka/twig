import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, FilePenLine, Github, Gitlab, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { AGE_STOPS, ageStop, ageTextClass } from '../graph/age-color.js';
import { MARK_COLORS, MARK_LABELS } from '../graph/mark-color.js';
import { authorInitials, authorTint } from '../graph/layout.js';
import { forgeLabel, forgeLinks } from './forge-url.js';
import { signatureView } from './signature-view.js';
import { FILE_SORTS, compareFiles } from './file-sort.js';
import FileStatus from '../diff/FileStatus.jsx';
import FileTree from '../diff/FileTree.jsx';
import { baseName } from '../diff/file-filter.js';
import { isMenuKey } from '../../app/shortcuts.js';
import { revealInvisible } from '../../ui/invisible.js';
import { formatDateTime, t, tn } from '../../i18n/i18n.js';

function ForgeIcon({ forge, ...props }) {
  if (forge === 'github') return <Github {...props} />;
  if (forge === 'gitlab') return <Gitlab {...props} />;
  return <ExternalLink {...props} />;
}

/**
 * Right-click, or Shift+F10 / the Menu key on a focused row, opens the file
 * context menu — the same two ways the commit graph reaches its own menu.
 */
function fileMenuProps(path, onFileMenu) {
  if (!onFileMenu) return {};
  return {
    onContextMenu: event => { event.preventDefault(); onFileMenu(path, event.clientX, event.clientY); },
    onKeyDown: event => {
      if (!isMenuKey(event)) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      onFileMenu(path, box.left + 24, box.bottom);
    }
  };
}

/** Below this many a commit's list needs no view switch, filter or sort: there is nothing to pick from. */
const FILE_TOOLS_FROM = 8;
/** Past this many files a list shows its first ones and a button for the rest, and a tree starts with its folders closed. */
const FILE_STEP = 500;


const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "9 Oct 2026, 14:32" in the machine's time zone; an unreadable date stays as Git wrote it. */
function dateTime(value) {
  return value ? formatDateTime(value, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

// The author card and message body start collapsed; the choice is remembered
// like the theme so a commit opens the same way next time.
function loadShowDetails() {
  try { return localStorage.getItem('twig:commit-details') === 'show'; } catch { return false; }
}
function saveShowDetails(show) {
  try { localStorage.setItem('twig:commit-details', show ? 'show' : 'hide'); } catch { /* private mode */ }
}

const SIGNATURE_ICONS = { good: ShieldCheck, warn: ShieldAlert, bad: ShieldX, none: ShieldQuestion };

/** Icon and words both carry the verdict; the tone only colours the icon. */
function SignatureLine({ signature }) {
  const view = signatureView(signature);
  const Icon = SIGNATURE_ICONS[view.tone];
  return <p className={`signature-line signature-${view.tone}`} title={view.detail}>
    <Icon aria-hidden="true" /><strong>{view.label}</strong><span>{view.detail}</span>
  </p>;
}

export default function CommitPanel({ repositoryId, commit, loading, error, onClose, onParent, onFile, openPath = null, onFileMenu, onConsole, range, commitColors = 'lanes', remotes = [], mark = null, onSetMark, onClearMark }) {
  const [tree, setTree] = useState(false);
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState('path');
  const [allFiles, setAllFiles] = useState(null);
  const [fileError, setFileError] = useState('');
  const [filter, setFilter] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [showDetails, setShowDetails] = useState(loadShowDetails);
  // How many files of a long list are drawn; a commit or a filter starts over.
  const [fileLimit, setFileLimit] = useState(FILE_STEP);
  useEffect(() => { setFileLimit(FILE_STEP); }, [commit?.oid, all, filter, range]);
  useEffect(() => { setNoteDraft(mark?.note || ''); }, [mark, commit?.oid]);
  useEffect(() => {
    let alive = true;
    setAllFiles(null); setFileError('');
    if (all && commit?.oid && !range) window.twig.getCommitFiles(repositoryId, commit.oid)
      .then(files => { if (alive) setAllFiles(files); }).catch(() => { if (alive) setFileError(t('Could not load the file tree.')); });
    return () => { alive = false; };
  }, [repositoryId, commit?.oid, all, range]);
  // Verifying runs gpg or ssh-keygen through Git, so it is read after the
  // commit itself and never holds the panel up.
  const [signature, setSignature] = useState(null);
  useEffect(() => {
    let alive = true;
    setSignature(null);
    if (commit?.oid && !range && window.twig.getSignature) window.twig.getSignature(repositoryId, commit.oid)
      .then(result => { if (alive) setSignature({ oid: commit.oid, ...result }); })
      .catch(() => { if (alive) setSignature({ oid: commit.oid, error: true }); });
    return () => { alive = false; };
  }, [repositoryId, commit?.oid, range]);
  const files = useMemo(() => (all && !range ? allFiles || [] : commit?.files || [])
    .filter(file => file.path.toLowerCase().includes(filter.toLowerCase()))
    .slice().sort(compareFiles(sort)),
  [all, range, allFiles, commit, filter, sort]);
  // The committed date carries the same age colour as its row in the graph.
  const age = commitColors === 'age' && commit ? ageStop(commit.committedAt) : null;
  const links = useMemo(
    () => forgeLinks(remotes, { oid: commit?.oid, email: commit?.author?.email }),
    [remotes, commit?.oid, commit?.author?.email]
  );
  const email = commit?.author?.email || '';
  const fileTools = all || tree || filter || (commit?.files.length ?? 0) >= FILE_TOOLS_FROM;
  // The file whose diff is open in the centre stays lit, as in the uncommitted panel.
  const fileButton = (file, label) => <button className="commit-file" key={file.path} aria-pressed={file.path === openPath}
    onClick={() => onFile(file.path)} title={file.path} {...fileMenuProps(file.path, onFileMenu)}><FileStatus status={file.status} /><span>{label}</span></button>;
  return <aside className="commit-detail" aria-label={t('Commit details')}>
    <header className="panel-heading">
      <span>{range ? t('COMPARE') : t('COMMIT')} <code>{commit?.oid.slice(0, 8) || '…'}</code></span>
      {links?.commit && <a className="forge-link" href={links.commit} rel="noreferrer" title={t`Open this commit on ${forgeLabel(links.forge)}`}>
        <ForgeIcon forge={links.forge} aria-hidden="true" /><span>{forgeLabel(links.forge)}</span>
      </a>}
      <Button icon={X} aria-label={t('Close commit details')} onClick={onClose} />
    </header>
    <div className="detail-content">
      {loading && <div aria-busy="true" aria-label={t('Loading commit')}>{Array.from({ length: 8 }, (_, i) => <div className="skeleton detail-skeleton" key={i} />)}</div>}
      {error && <p role="alert">{error} <button onClick={onConsole}>{t('Show output')}</button></p>}
      {!loading && !error && commit && <>
        {range && <p className="muted">{t`Changes from ${range.base.slice(0, 8)} to ${range.oid.slice(0, 8)}`}</p>}
        {/* Long subjects stop at three lines, so the files stay in the panel; Show details gives the rest. */}
        <h2 className={showDetails || range ? 'commit-subject-heading' : 'commit-subject-heading clamped'} title={commit.subject || undefined}>{revealInvisible(commit.subject) || t('(no subject)')}</h2>
        {!range && <p className="commit-byline">
          <span className={`author-dot author-tint-${authorTint(commit.author)}`} aria-hidden="true">{authorInitials(commit.author.name)}</span>
          <span className="commit-byline-name" title={email}>{revealInvisible(commit.author.name)}</span>
          <time dateTime={commit.author.date} title={commit.committedAt !== commit.author.date ? t`Committed ${dateTime(commit.committedAt)}` : undefined}>{dateTime(commit.author.date)}</time>
        </p>}
        {!range && signature?.signed && <SignatureLine signature={signature} />}
        {!range && <button type="button" className="text-button details-toggle" aria-expanded={showDetails}
          onClick={() => { const next = !showDetails; setShowDetails(next); saveShowDetails(next); }}>
          {showDetails ? t('Hide details') : t('Show details')}
        </button>}
        {(showDetails || range) && <>
          {commit.body && <pre className="commit-body">{revealInvisible(commit.body)}</pre>}
          <div className="author-card"><span className="avatar">{commit.author.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><div>
            <strong>{revealInvisible(commit.author.name)}{links?.authorCommits && <a className="forge-link" href={links.authorCommits} rel="noreferrer" title={t`Commits by ${commit.author.name} on ${forgeLabel(links.forge)}`}><ForgeIcon forge={links.forge} aria-hidden="true" /></a>}</strong>
            <span>{EMAIL.test(email) ? <a className="text-link" href={`mailto:${email}`}>{email}</a> : email}</span>
          </div></div>
          <dl className="metadata"><dt>{t('Authored')}</dt><dd>{formatDateTime(commit.author.date, { dateStyle: 'short', timeStyle: 'medium' })}</dd><dt>{t('Committed')}</dt><dd className={ageTextClass(age)} title={age === null ? undefined : t(AGE_STOPS[age].label)}>{formatDateTime(commit.committedAt, { dateStyle: 'short', timeStyle: 'medium' })}</dd><dt>{t('Parents')}</dt><dd>{commit.parents.length ? commit.parents.map(oid => <button key={oid} className="text-button" onClick={() => onParent(oid)}>{oid.slice(0, 8)}</button>) : t('Root commit')}</dd>
            {!range && <><dt>{t('Signature')}</dt><dd>{signature?.error ? t('Could not be read') : signatureView(signature).label}</dd></>}</dl>
        </>}
        {!range && onSetMark && <div className="mark-editor">
          <span className="mark-label">{mark ? t('Mark') : t('Mark this commit')}</span>
          <div className="mark-swatches" role="group" aria-label={t('Commit mark colour')}>
            {MARK_COLORS.map(color => <button key={color} type="button"
              className={`mark-swatch mark-${color} ${mark?.color === color ? 'active' : ''}`}
              aria-pressed={mark?.color === color} aria-label={t(MARK_LABELS[color])} title={t(MARK_LABELS[color])}
              onClick={() => onSetMark(commit.oid, color, noteDraft)} />)}
            {mark && <button type="button" className="text-button mark-remove" onClick={() => onClearMark(commit.oid)}>{t('Remove mark')}</button>}
          </div>
          {mark && <div className="mark-note">
            <textarea aria-label={t('Mark note')} placeholder={t('Note (optional)')} rows={2} maxLength={2000}
              value={noteDraft} onChange={e => setNoteDraft(e.target.value)} />
            <Button className="secondary" onClick={() => onSetMark(commit.oid, mark.color, noteDraft)}
              reason={noteDraft === (mark.note || '') ? t('The note is unchanged') : undefined}>{t('Save note')}</Button>
          </div>}
        </div>}
        <div className="files-heading"><FilePenLine /><strong>{tn(commit.files.length, '{n} changed file', '{n} changed files')}</strong>
          <label className="files-all"><input type="checkbox" checked={all && !range} disabled={Boolean(range)} onChange={e => setAll(e.target.checked)} /> {t('All files')}</label></div>
        {commit.parents.length > 1 && !range && <p className="muted">{t('Compared with first parent')}</p>}
        {fileTools && <div className="file-controls"><div className="segmented"><button aria-pressed={!tree} onClick={() => setTree(false)}>{t('Path')}</button><button aria-pressed={tree} onClick={() => setTree(true)}>{t('Tree')}</button></div><input aria-label={t('Filter commit files')} placeholder={t('Filter files')} value={filter} onChange={e => setFilter(e.target.value)} /><select aria-label={t('Sort commit files')} value={sort} onChange={e => setSort(e.target.value)}>{FILE_SORTS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}</select></div>}
        {fileError && <p role="alert">{fileError}<button onClick={onConsole}>{t('Show output')}</button></p>}
        {all && !allFiles && !range ? <div className="skeleton" aria-label={t('Loading files')} /> : tree ? <FileTree files={files} startOpen={files.length <= FILE_STEP} resetKey={files}
          renderFile={file => fileButton(file, baseName(file.path))} /> : <>{files.slice(0, fileLimit).map(file => fileButton(file, file.path))}
          {files.length > fileLimit && <button type="button" className="text-button" onClick={() => setFileLimit(files.length)}>{tn(files.length, 'Show all {n} file', 'Show all {n} files')}</button>}</>}
        {!files.length && (!all || allFiles) && <p className="muted">{t('No matching files.')}</p>}
      </>}
    </div>
  </aside>;
}
