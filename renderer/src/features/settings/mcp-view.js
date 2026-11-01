// Words for Settings → AI agents (MCP). Vite and the Node check load it.
import { t, tn, tr } from '../../i18n/i18n.js';

/** The status line under the switch, or '' when there is nothing to say (Off, no error). */
export function mcpStatusLine(status) {
  if (!status) return '';
  if (status.error) return t`Could not start the MCP server: ${tr(status.error)}`;
  if (!status.listening) return '';
  const agents = status.connections
    ? tn(status.connections, '{n} agent connected', '{n} agents connected')
    : t('No agent connected yet');
  const calls = status.calls
    ? tn(status.calls, '{n} request answered this session', '{n} requests answered this session')
    : '';
  return t`Listening. ${calls ? `${agents} · ${calls}` : agents}.`;
}

/** The summary in the main Settings list, next to the button that opens the panel. */
export function mcpSummary(settings) {
  if (!settings) return t('Let coding agents read your repositories through 🌱 Twig.');
  if (settings.status?.error) return t('Could not start — open to see why.');
  return settings.enabled ? t('On — agents can read connected repositories. Read-only.') : t('Off. Let coding agents such as Claude Code read your repositories, read-only.');
}

/** The toolbar button's name and tooltip: what it opens, and whether the server is on. */
export function mcpToolTitle(settings) {
  if (settings?.status?.error) return t('MCP: could not start — connect AI agents');
  return settings?.enabled ? t('MCP: on — AI agents can read your repositories') : t('MCP: off — connect AI agents such as Claude Code');
}
