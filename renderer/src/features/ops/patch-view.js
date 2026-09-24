/**
 * Words and the shown command for applying a patch file. No imports: Vite and
 * the Node check both load it, and the check holds the command against the
 * argv main builds.
 */

/** The command as the dialog prints it; main passes the full path where this shows the name. */
export function patchCommand(patch, index = false) {
  return patch.kind === 'mbox' ? ['am', '--3way', '--', patch.name] : ['apply', ...(index ? ['--index'] : []), '--', patch.name];
}

/** Printed the way the console logs it: a name with a space or a quote is one quoted word. */
export const patchCommandText = (patch, index = false) => patchCommand(patch, index)
  .map(arg => (/[\s"'`$\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');

export function patchConsequence(patch, branch, index = false) {
  const target = branch || 'HEAD';
  if (patch.kind === 'mbox') {
    const count = patch.commits.length;
    return `${count === 1 ? 'One new commit is' : `${count} new commits are`} made on ${target}, with the authors, dates and messages the patch carries. Undo takes them all back.`;
  }
  return `The changes are written into your working files${index ? ' and staged' : ''}; no commit is made. Undo cannot take them back, but Discard can.`;
}

/** The oids to export, oldest first, from the graph's newest-first selection. */
export const exportOrder = commits => commits.map(commit => commit.oid).reverse();
