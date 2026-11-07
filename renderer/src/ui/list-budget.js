// How many rows a long list draws before it asks. A file row is about fifteen
// DOM nodes: 20 000 changed files were 320 000 nodes and two seconds per
// keystroke, while nobody reads past the first screens. The rest is one click
// away. No imports: Vite and the Node check both load this module.

export const LIST_BUDGET = 500;

/** The rows to draw, and how many the list holds when some are left out (else 0). */
export function budgetSlice(items, showAll, budget = LIST_BUDGET) {
  const over = !showAll && items.length > budget;
  return { shown: over ? items.slice(0, budget) : items, hidden: over ? items.length : 0 };
}
