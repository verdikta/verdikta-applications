// Where the site's chain, contract and IPFS gateway are: Vite build variables, so a deployment
// builds the client for one network. The API is same-origin (/api).
//
//   VITE_SA_CHAIN_ID     the chain StakeAttestation is on (84532 Base Sepolia, 8453 Base, 31337 local)
//   VITE_SA_CONTRACT     the StakeAttestation address (its lens views answer at the same address)
//   VITE_SA_RPC_URL      a JSON-RPC endpoint for reads; without one, reads go through the wallet
//   VITE_IPFS_GATEWAY    the gateway disclosed ciphertexts are fetched from (…/ipfs/<cid>)
const env = import.meta.env ?? {};

const trimSlash = (s) => (s ? String(s).replace(/\/+$/, '') : null);

export const CONFIG = Object.freeze({
  chainId: env.VITE_SA_CHAIN_ID ? Number(env.VITE_SA_CHAIN_ID) : null,
  contract: env.VITE_SA_CONTRACT || null,
  rpcUrl: trimSlash(env.VITE_SA_RPC_URL),
  ipfsGateway: trimSlash(env.VITE_IPFS_GATEWAY),
});

export const chainConfigured = () => Boolean(CONFIG.chainId && CONFIG.contract);
