import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import { buildPreload } from './build.mjs';

await buildPreload();
const server = await createServer();
await server.listen();
const env = { ...process.env, GIT_DESK_DEV: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], {
  stdio: 'inherit', shell: false,
  env
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child.kill();
  await server.close();
  process.exitCode = code;
}
child.on('exit', (code) => { void stop(code ?? 0); });
child.on('error', (error) => { console.error(error.message); void stop(1); });
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
