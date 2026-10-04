import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Where the bridge script, its protocol module and the endpoint pointer live, under userData. */
export const MCP_DIRNAME = 'mcp';
export const BRIDGE_FILE = 'twig-mcp.mjs';
export const PROTOCOL_FILE = 'protocol.mjs';
export const ENDPOINT_FILE = 'endpoint.json';
export const SERVER_KEY = 'twig';

// sockaddr_un holds 104 bytes on macOS and 108 on Linux, terminator included.
const SOCKET_PATH_MAX = 100;

/**
 * Where 🌱 Twig listens. A Unix socket inside userData/mcp, a folder only this
 * account can open; when that path is too long for a socket, a 0700 folder
 * under the account's temp directory named by a hash of userData. On Windows,
 * a named pipe with the same hash. The bridge never computes this — it reads
 * the endpoint file 🌱 Twig writes next to it.
 * @param {{ userData: string, platform?: string, tmpdir?: string }} options
 * @returns {{ dir: string, socket: string, socketDir: ?string }}
 */
export function resolveEndpoint({ userData, platform = process.platform, tmpdir = os.tmpdir() }) {
  const dir = path.join(userData, MCP_DIRNAME);
  const hash = createHash('sha256').update(userData, 'utf8').digest('hex').slice(0, 16);
  if (platform === 'win32') return { dir, socket: `\\\\.\\pipe\\twig-mcp-${hash}`, socketDir: null };
  const preferred = path.join(dir, 'twig.sock');
  if (Buffer.byteLength(preferred) <= SOCKET_PATH_MAX) return { dir, socket: preferred, socketDir: dir };
  const socketDir = path.join(tmpdir, `twig-mcp-${hash}`);
  return { dir, socket: path.join(socketDir, 'twig.sock'), socketDir };
}

/**
 * The command an MCP client starts. 🌱 Twig's own executable runs the bridge
 * as plain Node (`ELECTRON_RUN_AS_NODE=1`), so no separate Node install is
 * needed and no window opens. An AppImage is started through `$APPIMAGE`: its
 * executable lives in a mount that changes on every launch.
 * @param {{ execPath: string, appImage?: ?string, dir: string }} options
 */
export function launchCommand({ execPath, appImage = null, dir }) {
  return { command: appImage || execPath, args: [path.join(dir, BRIDGE_FILE)], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

const posixQuote = value => /^[\w./:=@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
const windowsQuote = value => /^[\w.\\:=@-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
const tomlString = value => JSON.stringify(value);

/**
 * Ready-to-paste client configuration: the `claude mcp add` line for Claude
 * Code (user scope, so every project sees it), a `[mcp_servers]` table for
 * Codex's config.toml, and the `mcpServers` JSON Cursor and most other
 * clients read.
 * @param {{ command: string, args: string[], env: Record<string, string> }} launch
 * @param {string} [platform]
 */
export function clientConfigs(launch, platform = process.platform) {
  const quote = platform === 'win32' ? windowsQuote : posixQuote;
  const envFlags = Object.entries(launch.env).map(([key, value]) => `--env ${key}=${value}`).join(' ');
  const claude = `claude mcp add --scope user ${SERVER_KEY} ${envFlags} -- ${[launch.command, ...launch.args].map(quote).join(' ')}`;
  const codex = [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(', ')}]`,
    `env = { ${Object.entries(launch.env).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`
  ].join('\n');
  const json = JSON.stringify({ mcpServers: { [SERVER_KEY]: { command: launch.command, args: launch.args, env: launch.env } } }, null, 2);
  return { claude, codex, json };
}
