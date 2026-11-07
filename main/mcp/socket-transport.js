import net from 'node:net';
import { chmod, unlink } from 'node:fs/promises';

/** One message line larger than this closes the connection: no request to these tools comes near it. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** Concurrent clients; each agent session holds one connection through its bridge. */
export const MAX_CONNECTIONS = 16;
/** Answers a client has not read, past which it is cut off: they would pile up in the main process. */
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;
/** A connection silent this long that never said `initialize` is not an agent. */
export const HELLO_TIMEOUT_MS = 30_000;

/**
 * Newline-delimited JSON-RPC over a local socket — the framing MCP's stdio
 * transport uses, so the bridge only copies bytes. Each connection gets its
 * own session from `createSession`, which decides what runs when; requests on
 * one connection are answered as they finish, which JSON-RPC allows.
 *
 * When every place is taken, the connection idle the longest gives way to the
 * new one: a bridge reconnects on its next message, so an agent that was quiet
 * loses nothing, and sixteen idle sockets cannot lock real agents out.
 *
 * The transport knows nothing about tools: another transport (HTTP, say)
 * would take the same `createSession` and nothing else would change.
 * `onClose` hears when a connection — an agent session — ends.
 * @param {{ socket: string, createSession: () => { handleLine: (line: string) => Promise<object|null>, close?: () => void, initialized?: boolean },
 *   onClose?: () => void, helloTimeoutMs?: number, maxWriteBytes?: number }} options
 */
export function createSocketTransport({ socket, createSession, onClose = () => {}, helloTimeoutMs = HELLO_TIMEOUT_MS, maxWriteBytes = MAX_WRITE_BYTES }) {
  let server = null;
  const connections = new Set();
  const sessions = new Map();
  const activity = new Map();

  /** The open connection with nothing in flight that was active the longest ago, or null. */
  function longestIdle() {
    const idle = [...activity].filter(([, state]) => state.pending === 0).sort(([, a], [, b]) => a.at - b.at);
    return idle[0]?.[0] ?? null;
  }

  function serve(connection) {
    if (connections.size >= MAX_CONNECTIONS) {
      const idle = longestIdle();
      if (!idle) { connection.destroy(); return; }
      idle.destroy();
      connections.delete(idle);
      activity.delete(idle);
    }
    connections.add(connection);
    const session = createSession();
    const state = { pending: 0, at: performance.now() };
    sessions.set(connection, session);
    activity.set(connection, state);
    connection.on('close', () => {
      connections.delete(connection); sessions.delete(connection); activity.delete(connection);
      session.close?.();
      onClose();
    });
    connection.on('error', () => {});
    connection.setTimeout(helloTimeoutMs, () => {
      if (session.initialized === false && state.pending === 0) connection.destroy();
    });
    let buffer = '';
    connection.setEncoding('utf8');
    connection.on('data', chunk => {
      buffer += chunk;
      state.at = performance.now();
      if (buffer.length > MAX_LINE_BYTES && !buffer.includes('\n')) { connection.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        state.pending++;
        void session.handleLine(line).then(response => {
          if (!response || connection.destroyed) return;
          connection.write(`${JSON.stringify(response)}\n`);
          if (connection.writableLength > maxWriteBytes) connection.destroy();
        }, () => {}).finally(() => { state.pending--; state.at = performance.now(); });
      }
    });
  }

  return {
    get connections() { return connections.size; },
    /** The sessions of the open connections. */
    sessions() { return [...sessions.values()]; },
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
