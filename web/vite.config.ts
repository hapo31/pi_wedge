import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'], react: ['react', 'react-dom'], gcode: ['gcode-preview'] },
      },
    },
  },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3000' } },
});
