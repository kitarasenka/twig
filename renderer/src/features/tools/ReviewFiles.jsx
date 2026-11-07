import { memo } from 'react';
import { FilePlus2 } from 'lucide-react';
import { ShowAll, useBudget } from '../../ui/useBudget.jsx';
import FileStatus from '../diff/FileStatus.jsx';
import { showAllFiles } from '../diff/FileList.jsx';
import { t } from '../../i18n/i18n.js';

/** The files of a review. On its own so that opening one file does not draw the others again. */
const ReviewFiles = memo(function ReviewFiles({ files, openPath, onFile }) {
  const budget = useBudget(files);
  return <ul className="stash-files" aria-label={t('Files this worktree changed')}>
    {files.length === 0 && <li className="empty-inline">{t('Nothing changed yet.')}</li>}
    {budget.shown.map(file => <li key={`${file.path}:${file.untracked}`}>
      <button type="button" className={openPath === file.path ? 'selected' : ''} aria-pressed={openPath === file.path} onClick={() => onFile(file)}>
        <FileStatus status={file.status} />
        <span title={file.path}>{file.path}</span>
        {file.untracked ? <small><FilePlus2 aria-hidden="true" />{t('untracked')}</small>
          : file.insertions !== null && <small>+{file.insertions} −{file.deletions}</small>}
      </button>
    </li>)}
    {budget.hidden > 0 && <li><ShowAll budget={budget} label={showAllFiles} /></li>}
  </ul>;
});

export default ReviewFiles;
