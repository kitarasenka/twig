import { useEffect, useMemo, useState } from 'react';
import { ALL_TYPES, buildFileTree, extensionOptions } from './file-filter.js';

/**
 * Files under collapsible folders. `renderFile(file)` draws one file row.
 * A folder's files are drawn only while it is open: 8 000 files under open
 * folders froze the window for two seconds on switching to the tree. Folders
 * start open unless `startOpen` says otherwise; what the person opened or
 * closed is kept until `resetKey` changes (a new commit, not a status refresh).
 */
export default function FileTree({ files, renderFile, startOpen = true, resetKey }) {
  const [toggled, setToggled] = useState(() => new Map());
  useEffect(() => { setToggled(new Map()); }, [resetKey]);
  const tree = useMemo(() => buildFileTree(files), [files]);
  function render(node, prefix = '') {
    return <>{[...node.folders].map(([name, child]) => {
      const key = `${prefix}${name}/`;
      const open = toggled.get(key) ?? startOpen;
      return <details className="file-folder" key={name} open={open}>
        <summary onClick={event => { event.preventDefault(); setToggled(current => new Map(current).set(key, !open)); }}>{name}</summary>
        {open && render(child, key)}</details>;
    })}
      {node.files.map(renderFile)}</>;
  }
  return render(tree);
}

/**
 * Path / Tree, the text filter and the file-type select, as one block of
 * controls above a set of file lists. `paths` are every path the lists hold,
 * so the type choices count what is there before any filter.
 */
export function FileListControls({ view, onView, filter, onFilter, extension, onExtension, paths, label }) {
  const options = extensionOptions(paths, extension);
  return <>
    <div className="file-controls">
      <div className="segmented" role="group" aria-label={`Show ${label} as`}>
        <button aria-pressed={view === 'path'} onClick={() => onView('path')}>Path</button>
        <button aria-pressed={view === 'tree'} onClick={() => onView('tree')}>Tree</button>
      </div>
      <select aria-label={`Filter ${label} by type`} value={extension} onChange={event => onExtension(event.target.value)}>
        <option value={ALL_TYPES}>All types</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
    <div className="file-controls">
      <input aria-label={`Filter ${label}`} placeholder="Filter files" value={filter} onChange={event => onFilter(event.target.value)} />
    </div>
  </>;
}
