import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2021',
    chunkSizeWarningLimit: 4000,
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
  },
}));
