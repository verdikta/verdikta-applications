// Where the site's chain, contract and IPFS gateways are: Vite build variables, so a deployment
// builds the client for one network. The API is same-origin (/api).
//
//   VITE_SA_CHAIN_ID     the chain StakeAttestation is on (84532 Base Sepolia, 8453 Base, 31337 local)
//   VITE_SA_CONTRACT     the StakeAttestation address (its lens views answer at the same address)
//   VITE_SA_RPC_URL      a JSON-RPC endpoint for reads; without one, reads go through the wallet
//   VITE_IPFS_GATEWAY    the gateways disclosed ciphertexts are fetched from (…/ipfs/<cid>): one origin, or several,
//                        comma-separated, which the check page asks in order (lib/fetchCiphertext.js); the record
//                        page links an archive to the first. Each is an https origin, or plain http on a loopback
//                        address (the tests' stand-ins). An entry that is neither, or that has a path, query or
//                        credentials, is left out, and one named twice is asked once.
const env = import.meta.env ?? {};

const trimSlash = (s) => (s ? String(s).replace(/\/+$/, '') : null);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * VITE_IPFS_GATEWAY's gateways, in order, each as its origin.
 * @param {string|undefined|null} value
 * @returns {readonly string[]}
 */
export function parseGateways(value) {
  const out = [];
  for (const entry of String(value ?? '').split(',')) {
    const text = entry.trim();
    if (!text) continue;
    let u;
    try {
      u = new URL(text);
    } catch {
      continue;
    }
    const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
    const bare = !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && !/[?#]/.test(text);
    if (scheme && bare && !out.includes(u.origin)) out.push(u.origin);
  }
  return Object.freeze(out);
}

const ipfsGateways = parseGateways(env.VITE_IPFS_GATEWAY);

export const CONFIG = Object.freeze({
  chainId: env.VITE_SA_CHAIN_ID ? Number(env.VITE_SA_CHAIN_ID) : null,
  contract: env.VITE_SA_CONTRACT || null,
  rpcUrl: trimSlash(env.VITE_SA_RPC_URL),
  ipfsGateways,
  // the first, for the record page's archive links
  ipfsGateway: ipfsGateways[0] ?? null,
});

export const chainConfigured = () => Boolean(CONFIG.chainId && CONFIG.contract);
