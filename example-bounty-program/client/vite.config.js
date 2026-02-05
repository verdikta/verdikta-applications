import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Select backend port based on mode: base=5005, base-sepolia=5006
  const backendPort = mode === 'base-sepolia' ? 5006 : 5005;

  return {
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
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
          secure: false,
          // by default Vite preserves the /api prefix; no rewrite needed
          // Forward custom headers for client identification
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              // Ensure X-Client-Key header is forwarded
              if (req.headers['x-client-key']) {
                proxyReq.setHeader('x-client-key', req.headers['x-client-key']);
              }
            });
          },
        },
        // 👇 Receipt pages - server-rendered HTML for OG tags (social media unfurling)
        '/r': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
          secure: false,
        },
        // 👇 OG images for receipts (SVG and PNG)
        '/og': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});

