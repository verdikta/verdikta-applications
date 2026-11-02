import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 5176: next free client port after the repository's other apps (see ../README.md).
// The API is the stake-attestation server (5009); the client calls it same-origin under /api,
// so both the dev server and `vite preview` proxy /api to SA_API_URL.
const api = { '/api': { target: process.env.SA_API_URL || 'http://127.0.0.1:5009' } };

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { output: { manualChunks: { ethers: ['ethers'], react: ['react', 'react-dom'] } } } },
  server: { port: 5176, strictPort: true, proxy: api },
  preview: { port: 5176, strictPort: true, proxy: api },
});
