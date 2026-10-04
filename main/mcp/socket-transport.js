import net from 'node:net';
import { chmod, unlink } from 'node:fs/promises';

/** One message line larger than this closes the connection: no request to these tools comes near it. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** Concurrent clients; each agent session holds one connection through its bridge. */
export const MAX_CONNECTIONS = 16;

/**
 * Newline-delimited JSON-RPC over a local socket — the framing MCP's stdio
 * transport uses, so the bridge only copies bytes. Each connection gets its
 * own session from `createSession`; requests on one connection are answered
 * as they finish, which JSON-RPC allows.
 *
 * The transport knows nothing about tools: another transport (HTTP, say)
 * would take the same `createSession` and nothing else would change.
 * @param {{ socket: string, createSession: () => { handleLine: (line: string) => Promise<object|null> } }} options
 */
export function createSocketTransport({ socket, createSession }) {
  let server = null;
  const connections = new Set();

  function serve(connection) {
    if (connections.size >= MAX_CONNECTIONS) { connection.destroy(); return; }
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    connection.on('error', () => {});
    const session = createSession();
    let buffer = '';
    connection.setEncoding('utf8');
    connection.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES && !buffer.includes('\n')) { connection.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        void session.handleLine(line).then(response => {
          if (response && !connection.destroyed) connection.write(`${JSON.stringify(response)}\n`);
        }, () => {});
      }
    });
  }

  return {
    get connections() { return connections.size; },
    async start() {
      if (server) return;
      // A socket file left by a crashed run would refuse the bind. Only this
      // account can write the folder it is in, so whatever is there is ours.
      if (!socket.startsWith('\\\\')) await unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
      const next = net.createServer(serve);
      await new Promise((resolve, reject) => {
        next.once('error', reject);
        next.listen(socket, () => { next.off('error', reject); resolve(); });
      });
      if (!socket.startsWith('\\\\')) await chmod(socket, 0o600);
      server = next;
    },
    async stop() {
      if (!server) return;
      const current = server;
      server = null;
      for (const connection of connections) connection.destroy();
      await new Promise(resolve => current.close(() => resolve()));
      if (!socket.startsWith('\\\\')) await unlink(socket).catch(() => {});
    }
  };
}
