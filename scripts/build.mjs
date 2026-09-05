import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { pathToFileURL } from 'node:url';

export async function buildPreload() {
  await bundle({
    entryPoints: ['preload/index.js'], outfile: 'dist/preload/index.cjs',
    bundle: true, platform: 'node', format: 'cjs', external: ['electron']
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildPreload();
  await build();
}
