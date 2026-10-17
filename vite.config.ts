import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '^/api/': 'http://127.0.0.1:3000', '^/mcp(?:/|$)': 'http://127.0.0.1:3000', '^/skills/': 'http://127.0.0.1:3000' },
  },
});
