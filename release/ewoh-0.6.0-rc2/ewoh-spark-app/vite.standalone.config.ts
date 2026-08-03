import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = process.cwd();

export default defineConfig({
  base: '/',
  root: path.resolve(root, 'client'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(root, 'client/src'),
      '@client': path.resolve(root, 'client'),
      '@shared': path.resolve(root, 'shared'),
      '@server': path.resolve(root, 'server'),
    },
  },
  server: {
    port: 8080,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  build: {
    outDir: path.resolve(root, 'dist/client'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: path.resolve(root, 'client/index.standalone.html'),
    },
  },
});
