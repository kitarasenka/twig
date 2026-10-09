/**
 * The sidebar's LOCAL / REMOTE / TAGS tree starts closed and opens only down
 * to the selected ref, closing again when the selection moves on. A smoke that
 * works with other refs in the sidebar opens every section and folder by hand
 * first — a closed one with one click, one opened by the selection with two,
 * so that it stays open whatever gets selected later.
 */
export async function expandRefTree(page) {
  const summaries = page.locator('.sidebar-sections details > summary');
  for (let i = 0; i < 500 && i < await summaries.count(); i++) {
    const summary = summaries.nth(i);
    const open = await summary.evaluate(node => node.parentElement.open);
    await summary.click();
    if (open) await summary.click();
  }
}
