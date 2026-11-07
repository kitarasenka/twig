/** The last name of a path: what a worktree is called on screen. On its own so the graph can load it without the words of the tool screens. */
export const folderLabel = folder => String(folder).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
