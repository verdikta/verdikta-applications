import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = process.env.BACKEND_PORT || 5007;

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    allowedHosts: [
      'agents.verdikta.org',
      'localhost',
      '127.0.0.1',
    ],
    proxy: {
      '/api': {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
        secure: false,
      },
      '/health': {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
