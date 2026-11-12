// Builds the service page into web/dist. The service serves it under a CSP without inline scripts or styles, so
// nothing may be inlined: no module-preload polyfill, no data: assets.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
  },
  // pnpm dev:web against a running service (pnpm service, default port 4720): log in there first, the cookie is shared.
  server: { port: 5173, strictPort: true, proxy: { '/api': process.env.TP_DEV_TARGET ?? 'http://127.0.0.1:4720' } },
});
