import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The central service's own pages: a separate origin and bundle from self-hosted installations. */
export default defineConfig({
  root: 'web/central',
  plugins: [react()],
  build: { outDir: '../../dist/central-web', emptyOutDir: true },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '^/(v1|\\.well-known)/': 'http://127.0.0.1:3100' },
  },
});
