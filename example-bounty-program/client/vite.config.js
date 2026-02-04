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
      'bounties-testnet.verdikta.org',
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
        // Forward custom headers for client identification
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            console.log('[Vite Proxy] Incoming headers:', Object.keys(req.headers).join(', '));
            console.log('[Vite Proxy] x-client-key:', req.headers['x-client-key'] ? 'present' : 'MISSING');
            // Ensure X-Client-Key header is forwarded
            if (req.headers['x-client-key']) {
              proxyReq.setHeader('x-client-key', req.headers['x-client-key']);
              console.log('[Vite Proxy] Forwarded x-client-key');
            }
          });
        },
      },
    },
  },
});

