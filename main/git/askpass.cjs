#!/usr/bin/env node
'use strict';
/*
 * The program Git (GIT_ASKPASS) and OpenSSH (SSH_ASKPASS) run when they need
 * an answer: a username, a password or token, a key's passphrase, or whether
 * to trust a host key. It runs as plain Node on 🌱 Twig's own executable.
 *
 * Only an action the person started gets TWIG_ASKPASS_SOCKET and a one-time
 * token (see main/askpass.js): the prompt goes to 🌱 Twig, which asks in its
 * window, and the answer comes back on stdout, where Git and ssh read it.
 * Cancel exits 1, and Git or ssh stops. Everything else — background fetch,
 * the agent's reads, 🌱 Twig's own reads — gets no socket and an empty answer,
 * as before: nothing may ask the person a question they did not cause.
 */
const socket = process.env.TWIG_ASKPASS_SOCKET;
const token = process.env.TWIG_ASKPASS_TOKEN;
if (!socket || !token) {
  process.stdout.write('');
  process.exit(0);
}
const net = require('node:net');
const prompt = String(process.argv[2] ?? '').slice(0, 4096);
const mode = String(process.env.SSH_ASKPASS_PROMPT ?? '').slice(0, 32);
let reply = '';
let done = false;
const finish = (code, text = null) => {
  if (done) return;
  done = true;
  if (text === null) process.exit(code);
  else process.stdout.write(`${text}\n`, () => process.exit(code));
};
const connection = net.createConnection(socket);
connection.setEncoding('utf8');
connection.on('connect', () => connection.write(`${JSON.stringify({ token, prompt, mode })}\n`));
connection.on('data', chunk => {
  reply += chunk;
  if (reply.length > 65536) connection.destroy();
});
connection.on('error', () => finish(1));
connection.on('close', () => {
  let answer = null;
  try { answer = JSON.parse(reply.trim()).answer; } catch { answer = null; }
  if (typeof answer === 'string') finish(0, answer);
  else finish(1);
});
