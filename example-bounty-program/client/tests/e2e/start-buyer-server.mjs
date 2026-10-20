// Isolated UI fixture: no .env loading, RPC proxy, API credentials or wallet.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { sharedCommonJs } from '../../viteSharedCommonJs.js';
import { fileURLToPath } from 'node:url';
Object.assign(process.env, {
  VITE_NETWORK: 'base-sepolia',
  VITE_BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA: '0x1111111111111111111111111111111111111111',
  VITE_VERDIKTA_AGGREGATOR_ADDRESS_BASE_SEPOLIA: '0x2222222222222222222222222222222222222222',
});
const server = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  configFile: false, envDir: false, plugins: [sharedCommonJs(), react()],
  resolve: { dedupe: ['ajv', 'ajv-formats'] },
  server: { host: '127.0.0.1', port: 5191, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } },
});
await server.listen();
