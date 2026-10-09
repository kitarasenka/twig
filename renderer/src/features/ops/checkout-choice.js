/**
 * What a double-click checks out. Pure, no imports: Vite and the Node check
 * load it alike.
 *
 * `refs` is what was double-clicked — one ref (a sidebar entry or a badge in
 * the graph) or every ref on a commit row. `locals` is every local branch, so a
 * remote branch that a local one already tracks checks out that local branch
 * instead of offering to create a second one.
 *
 * Answers `{ kind: 'branch', name, target }`, `{ kind: 'remote', ref }` (the
 * "Check out as a new branch" dialog) or `{ kind: 'none', reason }`. A row
 * whose branch is ambiguous (two local branches, or two remote ones and no
 * local) checks out nothing: guessing would switch to a branch the person did
 * not point at. Tags never check out on a double-click — that would detach HEAD.
 */
export function checkoutChoice(refs = [], { headBranch = null, locals = [] } = {}) {
  const list = (Array.isArray(refs) ? refs : []).filter(ref => ref && (ref.type === 'local' || ref.type === 'remote'));
  const local = list.filter(ref => ref.type === 'local');
  const remote = list.filter(ref => ref.type === 'remote');
  if (local.some(ref => ref.name === headBranch)) return { kind: 'none', reason: `${headBranch} is already checked out` };
  if (local.length === 1) return { kind: 'branch', name: local[0].name, target: local[0].target };
  if (local.length > 1) return { kind: 'none', reason: 'Several branches point here — double-click the one to check out' };
  if (remote.length === 1) {
    const ref = remote[0];
    const tracking = (Array.isArray(locals) ? locals : []).filter(item => item?.type === 'local' && item.upstream === ref.name);
    if (tracking.some(item => item.name === headBranch)) return { kind: 'none', reason: `${headBranch} already tracks ${ref.name}` };
    if (tracking.length === 1) return { kind: 'branch', name: tracking[0].name, target: tracking[0].target };
    return { kind: 'remote', ref };
  }
  if (remote.length > 1) return { kind: 'none', reason: 'Several branches point here — double-click the one to check out' };
  return { kind: 'none', reason: null };
}
