/**
 * Maps one line number in the *new* side of a `parent → commit` patch to the
 * range it corresponds to on the *old* (parent) side, so "Blame before this
 * change" can land on the right place instead of the same line number.
 *
 * No imports: this module is loaded both by Vite in the renderer and by Node
 * in the self-check, the same arrangement as `drop-plan.js`.
 *
 * @param {{ hunks: { oldStart:number, oldLines:number, newStart:number, newLines:number, lines: { kind:'context'|'add'|'delete' }[] }[] }} patch
 * @param {number} newLine 1-based line number in the commit being blamed
 * @returns {{ range: [number, number] | null, exact: boolean, note: string | null }}
 */
export function mapLineBack(patch, newLine) {
  if (!patch || !Array.isArray(patch.hunks)) return { range: null, exact: false, note: null };
  let oldEnd = 1;
  let newEnd = 1;
  for (const hunk of patch.hunks) {
    if (newLine < hunk.newStart) {
      const mapped = newLine - (newEnd - oldEnd);
      return { range: [Math.max(1, mapped), Math.max(1, mapped)], exact: true, note: null };
    }
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    const deletes = [];
    for (const entry of hunk.lines) {
      if (entry.kind === 'delete') { deletes.push(oldNo); oldNo++; continue; }
      if (entry.kind === 'add') {
        if (newNo === newLine) {
          if (deletes.length) {
            return { range: [deletes[0], deletes[deletes.length - 1]], exact: false,
              note: 'This line was changed here; the lines it replaced are highlighted in the earlier version.' };
          }
          const around = Math.max(1, hunk.oldStart);
          return { range: [around, around], exact: false,
            note: 'This line was added here; the surrounding lines of the earlier version are highlighted.' };
        }
        newNo++;
        continue;
      }
      // context line
      if (newNo === newLine) return { range: [oldNo, oldNo], exact: true, note: null };
      oldNo++;
      newNo++;
    }
    oldEnd = hunk.oldStart + hunk.oldLines;
    newEnd = hunk.newStart + hunk.newLines;
  }
  const mapped = newLine - (newEnd - oldEnd);
  return { range: [Math.max(1, mapped), Math.max(1, mapped)], exact: true, note: null };
}
