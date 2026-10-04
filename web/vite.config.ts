import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The engine and the API share one feeder roster in ../shared.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      // `npm run dev` + `uvicorn sunshift.main:app --port 8000` gives the CP-SAT path locally.
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('@react-three')) return 'r3f';
          if (id.includes('node_modules/gsap') || id.includes('node_modules/lenis')) return 'motion';
          return undefined;
        },
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
} as any);
