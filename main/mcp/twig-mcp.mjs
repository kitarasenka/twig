// 🌱 Twig's MCP stdio bridge. An MCP client (Claude Code, Codex, Cursor, …)
// starts this as its server process; it copies newline-delimited JSON-RPC
// between the client's stdio and the local socket 🌱 Twig listens on.
//
// 🌱 Twig copies this file and ./protocol.mjs into userData/mcp when Settings →
// AI agents (MCP) is on, and clients run it on 🌱 Twig's own executable with
// ELECTRON_RUN_AS_NODE=1. Node built-ins only: it must run from that folder
// with nothing else around it.
//
// When 🌱 Twig is not listening the bridge still answers — initialize and
// tools/list from the catalog, and every tool call with TWIG_UNAVAILABLE — so
// the client keeps its tools and the agent learns why they are empty. It
// retries the socket on every message, so starting 🌱 Twig later just works.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, TOOLS, UNAVAILABLE_MESSAGE, errorResult, negotiateVersion } from './protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPLAY_ID = '__twig_bridge_initialize__';

let socket = null;
let connecting = null;
let initialize = null;
const pending = new Map();
let queue = Promise.resolve();

function endpoint() {
  try { return JSON.parse(readFileSync(path.join(here, 'endpoint.json'), 'utf8')); } catch { return null; }
}

function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

function unavailable(id, method) {
  if (method === 'tools/call') write({ jsonrpc: '2.0', id, result: errorResult('TWIG_UNAVAILABLE', UNAVAILABLE_MESSAGE) });
  else write({ jsonrpc: '2.0', id, error: { code: -32603, message: UNAVAILABLE_MESSAGE } });
}

function answerLocally(message) {
  if (!('id' in message)) return;
  const { id, method, params } = message;
  if (method === 'initialize') {
    write({ jsonrpc: '2.0', id, result: {
      protocolVersion: negotiateVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: endpoint()?.version || '0.0.0' },
      instructions: INSTRUCTIONS
    } });
  } else if (method === 'ping') write({ jsonrpc: '2.0', id, result: {} });
  else if (method === 'tools/list') write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  else if (method === 'tools/call') unavailable(id, method);
  else write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function attach(connection) {
  let buffer = '';
  connection.setEncoding('utf8');
  connection.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.id === REPLAY_ID) continue;
      if (message && 'id' in message) pending.delete(message.id);
      process.stdout.write(`${line}\n`);
    }
  });
  connection.on('error', () => {});
  connection.on('close', () => {
    if (socket === connection) socket = null;
    // Requests 🌱 Twig had not answered when it went away are answered here,
    // so the client is never left waiting on an id.
    for (const [id, method] of pending) unavailable(id, method);
    pending.clear();
  });
}

function connect() {
  if (socket) return Promise.resolve(socket);
  if (connecting) return connecting;
  const target = endpoint()?.socket;
  if (!target) return Promise.resolve(null);
  connecting = new Promise(resolve => {
    const connection = net.connect(target);
    const fail = () => { connection.destroy(); resolve(null); };
    connection.once('error', fail);
    connection.once('connect', () => {
      connection.off('error', fail);
      attach(connection);
      socket = connection;
      resolve(connection);
    });
  }).finally(() => { connecting = null; });
  return connecting;
}

async function forward(line) {
  let message;
  try { message = JSON.parse(line); } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
    return;
  }
  const isInitialize = message.method === 'initialize';
  if (isInitialize) initialize = message.params ?? {};
  const wasConnected = Boolean(socket);
  const connection = await connect();
  if (!connection) { answerLocally(message); return; }
  // Attached mid-conversation: 🌱 Twig's session has not seen the client's
  // initialize, so it is replayed first and its answer dropped.
  if (!wasConnected && !isInitialize && initialize) {
    connection.write(`${JSON.stringify({ jsonrpc: '2.0', id: REPLAY_ID, method: 'initialize', params: initialize })}\n`);
    connection.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  if ('id' in message && typeof message.method === 'string') pending.set(message.id, message.method);
  connection.write(`${line}\n`);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline).replace(/\r$/, '');
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    // In order: a tools/call must not overtake the initialize before it.
    queue = queue.then(() => forward(line));
  }
});
// The client closed its side: answers still on their way from 🌱 Twig get a
// few seconds to arrive before the bridge goes.
process.stdin.on('end', () => {
  void queue.then(async () => {
    const deadline = Date.now() + 5000;
    while (pending.size && socket && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    socket?.end();
    process.exit(0);
  });
});
