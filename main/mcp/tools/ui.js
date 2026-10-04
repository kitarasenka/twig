/**
 * What the person is looking at in 🌱 Twig, as the window last reported it.
 * Only fields 🌱 Twig actually holds are filled: there is no branch selection
 * (clicking a branch selects its commit) and no hunk selection, so both are
 * always null rather than guessed.
 */
export function getUiContext(ctx) {
  const activeId = ctx.activeId();
  const repo = activeId ? ctx.repositories().find(item => item.id === activeId) : null;
  const ui = repo ? ctx.uiFor(repo.id) : null;
  return {
    repository: repo ? { name: repo.name, path: repo.path } : null,
    view: ui?.view ?? null,
    selectedBranch: null,
    selectedCommit: ui?.selectedCommit ?? null,
    selectedCommits: ui?.selectedCommits.length ? ui.selectedCommits : [],
    compare: ui?.compare ?? null,
    selectedFile: ui?.selectedFile ?? null,
    selectedHunk: null
  };
}
