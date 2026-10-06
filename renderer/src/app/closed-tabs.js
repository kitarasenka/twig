// Which repository tabs the person closed.
//
// Closing a tab is not removing the repository: it stays connected (Settings →
// Manage repositories, the REPOSITORY picker) and opening it again brings the
// tab back. The choice used to live only in memory, so every restart reopened
// every connected repository. It is a window preference like the theme, so it
// lives in localStorage; the demo tab has its own flag in main
// (`sandboxHidden`), because main skips seeding the sandbox while it is closed.
// No imports: Vite and the Node check both load this module directly.

export const CLOSED_TABS_KEY = 'twig:closed-tabs';

export function readClosedTabs(storage) {
  try {
    const value = JSON.parse(storage?.getItem(CLOSED_TABS_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []);
  } catch { return new Set(); }
}

export function writeClosedTabs(storage, closed) {
  try { storage?.setItem(CLOSED_TABS_KEY, JSON.stringify([...closed].sort())); }
  catch { /* The choice remains session-local if storage is unavailable. */ }
}

/**
 * The tab to start on: the remembered active repository while its tab is open,
 * otherwise the first open one; null when every tab is closed.
 */
export function startRepositoryId(repositories, activeId, closed) {
  const open = (Array.isArray(repositories) ? repositories : []).filter(item => item && !closed.has(item.id));
  return open.find(item => item.id === activeId)?.id ?? open[0]?.id ?? null;
}
