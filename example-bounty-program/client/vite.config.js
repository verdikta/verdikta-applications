import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,                 // listen on all interfaces (VPS-friendly)
    port: 5173,
    allowedHosts: [
      'bounties.verdikta.org',
      'playground.verdikta.org',
      'localhost',
      '127.0.0.1',
      '134.199.203.20'
    ],
    proxy: {
      // 👇 forward any /api/* request to your backend (no CORS, no preflight)
      '/api': {
        target: 'http://localhost:5005',
        changeOrigin: true,
        secure: false,
        // by default Vite preserves the /api prefix; no rewrite needed
      },
    },
  },
});

