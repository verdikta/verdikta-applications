import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ../shared holds plain CommonJS modules (no dependencies, no require calls) that the bounty
// server requires as they are. Serve them to the browser as ES modules: module.exports
// becomes the default export, and each of its keys a named export.
const sharedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared') + path.sep;
const requireShared = createRequire(import.meta.url);
function sharedCommonJs() {
  return {
    name: 'verdikta-shared-commonjs',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.startsWith(sharedDir) || !file.endsWith('.js')) return null;
      delete requireShared.cache[file];
      const names = Object.keys(requireShared(file));
      return {
        // A function scope keeps the module's own top-level names apart from the exports.
        code: `const __shared = (() => {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})();\nexport default __shared;\nexport const { ${names.join(', ')} } = __shared;\n`,
        map: null,
      };
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Select backend port based on mode: base=5005, base-sepolia=5006
  const backendPort = mode === 'base-sepolia' ? 5006 : 5005;

  return {
    plugins: [sharedCommonJs(), react()],
    // Shared wallet-free skill module is outside client; resolve its schema runtime here.
    resolve: { dedupe: ['ajv', 'ajv-formats'] },
    server: {
      host: true,                 // listen on all interfaces (VPS-friendly)
      port: 5173,
      // Vite's file watcher defaults to the project root, which in dev also
      // picks up the backend's runtime-written files (logs, jobs.json). Every
      // server log line or sync write was triggering a full browser reload,
      // producing a "continuously scrolling / vite connecting" loop on the
      // homepage. These files are server-only artifacts — never imported by
      // the client — so exclude them from HMR watching.
      watch: {
        ignored: [
          '**/*.log',
          '**/server/data/**',
        ],
      },
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
        // 👇 Agent discovery routes (served by Express)
        '/agents.txt': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
          secure: false,
        },
        '/feed.xml': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
          secure: false,
        },
        '/health': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});

