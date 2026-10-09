import path from 'node:path';
import { CWD_META, INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, TOOLS, errorResult, negotiateVersion, toolResult } from './protocol.mjs';
import { validateArguments } from './arguments.js';
import { McpError } from './errors.js';

/** The largest tool result text sent to a client. Tools cap themselves well below this; it is the backstop. */
export const MAX_RESULT_CHARS = 120_000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
// Messages in one JSON-RPC batch; MCP clients send one request at a time.
const MAX_BATCH = 32;

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

/** The client's working directory from `initialize`, or null when it is missing or not a plain absolute path. */
export function clientCwd(params) {
  const value = params?._meta?.[CWD_META];
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value) ? path.resolve(value) : null;
}

/**
 * One MCP conversation, independent of how bytes arrive: a transport hands it
 * parsed JSON-RPC messages and writes back whatever `handle` returns. Only the
 * methods a read-only tool server needs are answered; everything else is
 * "method not found".
 *
 * A session that never saw `initialize` still answers: the stdio bridge can
 * attach to 🌱 Twig mid-conversation (it was started before 🌱 Twig was), and
 * the bridge replays the client's `initialize` first — this is the fallback if
 * that replay did not happen.
 *
 * @param {{ version: string, tools: Record<string, (args: object, client: { cwd: ?string }) => Promise<object | string>>, onCall?: (name: string) => void }} options
 */
export function createMcpSession({ version, tools, onCall = () => {} }) {
  let protocolVersion = negotiateVersion(null);
  const client = { cwd: null };
  const catalog = new Map(TOOLS.map(definition => [definition.name, definition]));

  async function callTool(params) {
    const definition = typeof params?.name === 'string' ? catalog.get(params.name) : null;
    const run = definition ? tools[definition.name] : null;
    if (!run) return { error: [INVALID_PARAMS, `Unknown tool: ${String(params?.name)}`] };
    onCall(definition.name);
    try {
      const payload = await run(validateArguments(definition.inputSchema, params.arguments), client);
      const result = toolResult(payload);
      if (result.content[0].text.length > MAX_RESULT_CHARS) {
        return { result: errorResult('OUTPUT_TOO_LARGE', 'The result is larger than 🌱 Twig sends in one answer.',
          { hint: 'Request a specific file, hunk or a smaller page.' }) };
      }
      return { result };
    } catch (error) {
      if (error instanceof McpError) return { result: errorResult(error.code, error.message, error.extra) };
      return { result: errorResult('GIT_OPERATION_FAILED', error?.message || 'Git could not answer.',
        { hint: 'The exact Git command and its output are in 🌱 Twig’s console (Full History).' }) };
    }
  }

  async function dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // A response from the client (to a request this server never sends) is ignored, not answered.
      if (message && typeof message === 'object' && ('result' in message || 'error' in message)) return null;
      return rpcError(message?.id, INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    const notification = !('id' in message);
    if (notification) return null;
    if (!validId(message.id)) return rpcError(null, INVALID_REQUEST, 'Invalid request id');
    const { id, method, params } = message;
    switch (method) {
      case 'initialize':
        protocolVersion = negotiateVersion(params?.protocolVersion);
        client.cwd = clientCwd(params);
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version },
          instructions: INSTRUCTIONS
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const outcome = await callTool(params);
        return outcome.error ? rpcError(id, ...outcome.error) : rpcResult(id, outcome.result);
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return {
    /** @returns {Promise<object | object[] | null>} the response to write, or null for a notification */
    async handle(message) {
      if (Array.isArray(message)) {
        if (!message.length) return rpcError(null, INVALID_REQUEST, 'Empty batch');
        if (message.length > MAX_BATCH) return rpcError(null, INVALID_REQUEST, `A batch holds at most ${MAX_BATCH} messages`);
        // One at a time: every call may start Git processes, and a batch run all
        // at once could start thousands and stall the main process.
        const responses = [];
        for (const item of message) {
          const response = await dispatch(item);
          if (response) responses.push(response);
        }
        return responses.length ? responses : null;
      }
      return dispatch(message);
    },
    /** Parses one line of input; a line that is not JSON is answered with a parse error. */
    async handleLine(line) {
      let message;
      try { message = JSON.parse(line); } catch { return rpcError(null, PARSE_ERROR, 'Parse error'); }
      return this.handle(message);
    },
    get protocolVersion() { return protocolVersion; }
  };
}
