/** The text Copy details puts on the clipboard. No imports: the Node check loads it directly. */
export function errorDetails(error, componentStack = '') {
  const name = error?.name || 'Error';
  const message = error?.message ?? String(error);
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  return [`${name}: ${message}`, stack, componentStack.trim()].filter(Boolean).join('\n\n');
}
