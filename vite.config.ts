import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // Transform syntax for older Chromium browsers as well as current browsers.
  build: { outDir: 'dist/client', target: ['chrome80', 'edge80', 'firefox78', 'safari13.1'] },
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
});
