// Main answers every repository refresh with the whole workspace, as fresh
// objects that came through IPC. Each repository object is a prop of that
// repository's tab, so a new object for an unchanged repository re-rendered
// every open tab on every refresh of the active one. This keeps the previous
// object wherever nothing in it changed. No imports: Vite and the Node check
// both load this module.

/**
 * @param {?{ repositories?: object[] }} previous
 * @param {?{ repositories?: object[] }} next
 */
export function keepUnchangedRepositories(previous, next) {
  if (!previous?.repositories || !next || !Array.isArray(next.repositories)) return next;
  const before = new Map(previous.repositories.map(item => [item.id, item]));
  let reused = false;
  const repositories = next.repositories.map(item => {
    const old = before.get(item.id);
    if (old && JSON.stringify(old) === JSON.stringify(item)) { reused = true; return old; }
    return item;
  });
  return reused ? { ...next, repositories } : next;
}
