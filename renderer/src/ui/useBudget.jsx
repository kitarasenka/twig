import { useEffect, useState } from 'react';
import { budgetSlice } from './list-budget.js';

/**
 * A long list drawn in part (see list-budget.js). `resetKey` starts over: a
 * new search or tab is a new list, a refresh of the same one is not.
 */
export function useBudget(items, resetKey = null) {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [resetKey]);
  return { ...budgetSlice(items, showAll), showAll: () => setShowAll(true) };
}

/** The way to the rest of a list; `label` words it for the count. */
export function ShowAll({ budget, label }) {
  if (!budget.hidden) return null;
  return <button type="button" className="text-button list-show-all" onClick={budget.showAll}>{label(budget.hidden)}</button>;
}
