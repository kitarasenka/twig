// Words for Settings → AI agents (MCP). No imports: Vite and the Node check load it.

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The status line under the switch, or '' when there is nothing to say (Off, no error). */
export function mcpStatusLine(status) {
  if (!status) return '';
  if (status.error) return `Could not start the MCP server: ${status.error}`;
  if (!status.listening) return '';
  const agents = status.connections ? `${plural(status.connections, 'agent')} connected` : 'No agent connected yet';
  const calls = status.calls ? ` · ${plural(status.calls, 'request')} answered this session` : '';
  return `Listening. ${agents}${calls}.`;
}

/** The summary in the main Settings list, next to the button that opens the panel. */
export function mcpSummary(settings) {
  if (!settings) return 'Let coding agents read your repositories through 🌱 Twig.';
  if (settings.status?.error) return 'Could not start — open to see why.';
  return settings.enabled ? 'On — agents can read connected repositories. Read-only.' : 'Off. Let coding agents such as Claude Code read your repositories, read-only.';
}

/** The toolbar button's name and tooltip: what it opens, and whether the server is on. */
export function mcpToolTitle(settings) {
  if (settings?.status?.error) return 'MCP: could not start — connect AI agents';
  return settings?.enabled ? 'MCP: on — AI agents can read your repositories' : 'MCP: off — connect AI agents such as Claude Code';
}
