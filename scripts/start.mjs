import { spawn } from 'node:child_process';
import electron from 'electron';
import { brandDevelopmentApp } from './app-identity.mjs';

brandDevelopmentApp();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TWIG_DEV;
const child = spawn(electron, ['.'], { stdio: 'inherit', shell: false, env });
child.on('exit', (code) => { process.exitCode = code ?? 0; });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
