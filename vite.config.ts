import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Los .bin ya vienen comprimidos con gzip; el visor los descomprime en el worker.
  assetsInclude: ['**/*.bin'],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // three.js va en su propio bloque y solo se descarga al montar el mapa
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: { manualChunks: { three: ['three'] } },
    },
  },
});
