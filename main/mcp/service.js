import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BRIDGE_FILE, ENDPOINT_FILE, PROTOCOL_FILE, clientConfigs, launchCommand, resolveEndpoint } from './endpoint.js';
import { createSocketTransport } from './socket-transport.js';
import { createMcpSession } from './session.js';
import { createToolContext } from './context.js';
import { bindTools } from './tools/index.js';
import { normalizeUiContext } from './ui-context.js';

const SOURCES = [BRIDGE_FILE, PROTOCOL_FILE].map(name => ({ name, url: new URL(`./${name}`, import.meta.url) }));

async function writeAtomic(file, content) {
  const temporary = `${file}.next`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

/** A folder for the socket that only this account can enter — created so, or refused if it is anything else. */
async function privateFolder(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  await chmod(dir, 0o700);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a private folder of this account, so 🌱 Twig will not listen there.`);
  }
}

/**
 * The MCP server's lifecycle in main, with no Electron imports so the Node
 * check can drive it: it follows the active repository and the window's UI
 * selection, and, while Settings has it on, keeps the bridge files current in
 * userData/mcp and listens on the local socket. Off — the default — means no
 * socket and no listener at all.
 * @param {{ userData: string, execPath: string, appImage?: ?string, version: string,
 *   repositories: object, journal: object, platform?: string }} options
 */
export function createMcpService({ userData, execPath, appImage = null, version, repositories, journal, platform = process.platform }) {
  const endpoint = resolveEndpoint({ userData, platform });
  const launch = launchCommand({ execPath, appImage, dir: endpoint.dir });
  let activeId = null;
  let uiContext = null;
  let enabled = false;
  let error = null;
  let calls = 0;
  let lastCallAt = null;
  let changing = Promise.resolve();

  const context = createToolContext({ repositories, journal, getActiveId: () => activeId, getUiContext: () => uiContext });
  const tools = bindTools(context);
  const transport = createSocketTransport({
    socket: endpoint.socket,
    createSession: () => createMcpSession({ version, tools, onCall: () => { calls++; lastCallAt = new Date().toISOString(); } })
  });

  async function start() {
    await privateFolder(endpoint.dir);
    if (endpoint.socketDir && endpoint.socketDir !== endpoint.dir) await privateFolder(endpoint.socketDir);
    // Rewritten on every start, so the copy always matches the running version.
    for (const source of SOURCES) await writeAtomic(path.join(endpoint.dir, source.name), await readFile(source.url, 'utf8'));
    await transport.start();
    await writeAtomic(path.join(endpoint.dir, ENDPOINT_FILE), JSON.stringify({ socket: endpoint.socket, version }, null, 2));
  }

  async function stop() {
    await transport.stop();
    await rm(path.join(endpoint.dir, ENDPOINT_FILE), { force: true });
  }

  return {
    endpoint,
    /** Turns the listener on or off; serialized so a quick Off → On cannot interleave. */
    configure(next) {
      changing = changing.then(async () => {
        enabled = Boolean(next);
        error = null;
        try { await (enabled ? start() : stop()); }
        catch (failure) {
          error = failure.message;
          await transport.stop().catch(() => {});
        }
      });
      return changing;
    },
    /**
     * The repository open in the window, or null — set from the same
     * `repo:watch` the watcher follows. The UI context is kept: it names its
     * own repository, and a report for another one is simply not used.
     */
    follow(id) { activeId = id; },
    /** @returns {boolean} whether the report was valid and kept */
    setUiContext(raw) {
      const next = normalizeUiContext(raw);
      if (!next) return false;
      uiContext = next;
      return true;
    },
    status() {
      return { enabled, listening: enabled && !error, error, connections: transport.connections, calls, lastCallAt };
    },
    config() { return { launch, ...clientConfigs(launch, platform) }; },
    context
  };
}
