import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./renderer', import.meta.url)),
  base: './',
  plugins: [react(), {
    name: 'development-csp',
    apply: 'serve',
    // Dev only: HMR needs inline scripts and its websocket; the built page
    // keeps the strict policy from renderer/index.html.
    transformIndexHtml(html) {
      return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        .replace("connect-src 'self';", "connect-src 'self' ws://127.0.0.1:5188;");
    }
  }],
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  build: { outDir: '../dist/renderer', emptyOutDir: true }
});
