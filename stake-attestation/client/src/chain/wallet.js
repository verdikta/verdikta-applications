// The maker's wallet (an injected EIP-1193 provider) and the chain reads. Transactions go through
// the wallet only: list(), fund() and flagBadDisclosure(). Reads use VITE_SA_RPC_URL when the
// site has one, so the check page works before a wallet is connected.
import { BrowserProvider, Contract, JsonRpcProvider } from 'ethers';

import { CONFIG } from '../config.js';
import { STAKE_ATTESTATION_ABI } from './abi.js';

const POLL_MS = 1000;

export class WalletError extends Error {
  constructor(code, vars = {}) {
    super(code);
    this.code = code;
    this.vars = vars;
  }
}

export const hasWallet = () => typeof window !== 'undefined' && Boolean(window.ethereum);

/** Asks the wallet for an account on the site's chain. Resolves { provider, signer, account }. */
export async function connectWallet() {
  if (!CONFIG.contract || !CONFIG.chainId) throw new WalletError('notConfigured');
  if (!hasWallet()) throw new WalletError('none');
  const provider = new BrowserProvider(window.ethereum, undefined, { pollingInterval: POLL_MS });
  await provider.send('eth_requestAccounts', []);
  let { chainId } = await provider.getNetwork();
  if (Number(chainId) !== CONFIG.chainId) {
    try {
      await provider.send('wallet_switchEthereumChain', [{ chainId: `0x${CONFIG.chainId.toString(16)}` }]);
    } catch {
      // the wallet refused or does not know the chain; checked below
    }
    const again = new BrowserProvider(window.ethereum, undefined, { pollingInterval: POLL_MS });
    ({ chainId } = await again.getNetwork());
    if (Number(chainId) !== CONFIG.chainId) throw new WalletError('wrongChain', { actual: Number(chainId), expected: CONFIG.chainId });
    const signer = await again.getSigner();
    return { provider: again, signer, account: await signer.getAddress() };
  }
  const signer = await provider.getSigner();
  return { provider, signer, account: await signer.getAddress() };
}

let reader = null;
/** A provider for reads: the site's RPC endpoint, or the wallet's. */
export function readProvider() {
  if (!reader) {
    if (CONFIG.rpcUrl) reader = new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId ?? undefined, { staticNetwork: Boolean(CONFIG.chainId), pollingInterval: POLL_MS });
    else if (hasWallet()) reader = new BrowserProvider(window.ethereum, undefined, { pollingInterval: POLL_MS });
    else throw new WalletError('none');
  }
  return reader;
}

/** StakeAttestation at the configured address, for reads or (with a signer) transactions. */
export function stakeAttestation(runner = readProvider()) {
  if (!CONFIG.contract) throw new WalletError('notConfigured');
  return new Contract(CONFIG.contract, STAKE_ATTESTATION_ABI, runner);
}

/** The chain's time: the latest block's timestamp (the contract's clock, not the browser's). */
export async function chainNow(provider = readProvider()) {
  return BigInt((await provider.getBlock('latest')).timestamp);
}

/** The event `name` in a receipt, parsed with the client's ABI, or null. */
export function eventOf(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const e = contract.interface.parseLog(log);
      if (e?.name === name) return e;
    } catch {
      // another contract's log
    }
  }
  return null;
}
