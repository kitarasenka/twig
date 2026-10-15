import { Archive, ArchiveRestore, createLucideIcon } from 'lucide-react';

// Every stash surface is the same box: the graph node, the sidebar, the
// Stashes screen. Stash puts changes into it, Pop takes them out.
// Lucide has the "out" arrow (ArchiveRestore) but no "in" one, so ArchiveStash
// is its Archive with a downward arrow drawn into the box.
export const StashBox = Archive;
export const StashPop = ArchiveRestore;
export const StashPush = createLucideIcon('ArchiveStash', [
  ['rect', { width: '20', height: '5', x: '2', y: '3', rx: '1', key: 'lid' }],
  ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8', key: 'body' }],
  ['path', { d: 'M12 10v7', key: 'shaft' }],
  ['path', { d: 'm9 14 3 3 3-3', key: 'head' }]
]);
