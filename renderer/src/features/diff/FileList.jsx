import FileTree from './FileTree.jsx';
import { ShowAll, useBudget } from '../../ui/useBudget.jsx';
import { tn } from '../../i18n/i18n.js';

export const showAllFiles = count => tn(count, 'Show all {n} file', 'Show all {n} files');

/** A list of files by path or as a tree, drawn up to the budget. */
export default function FileList({ files, view, renderFile }) {
  const budget = useBudget(files, view);
  return <>
    {view === 'tree' ? <FileTree files={budget.shown} renderFile={renderFile} /> : budget.shown.map(renderFile)}
    <ShowAll budget={budget} label={showAllFiles} />
  </>;
}
