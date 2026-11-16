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

/**
 * Whether the wallet still has `wallet.account` selected on the site's chain. Wallets announce
 * changes (accountsChanged, chainChanged), but this asks, so one that does not is caught too.
 */
export async function stillConnected(wallet) {
  if (!wallet || !hasWallet()) return false;
  try {
    const [accounts, chainId] = await Promise.all([
      window.ethereum.request({ method: 'eth_accounts' }),
      window.ethereum.request({ method: 'eth_chainId' }),
    ]);
    return String(accounts?.[0] ?? '').toLowerCase() === wallet.account.toLowerCase() && Number(chainId) === CONFIG.chainId;
  } catch {
    return false;
  }
}

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

/** Throws wrongChain unless `provider` answers eth_chainId with `expected`. */
export async function verifyChain(provider, expected) {
  const actual = Number(await provider.send('eth_chainId', []));
  if (actual !== expected) throw new WalletError('wrongChain', { actual, expected });
}

let reader = null;
let readerChecked = false;
/**
 * A provider for reads on the site's chain: its RPC endpoint (checked once to be that chain), or
 * else the wallet's, checked on every call because the wallet can switch networks at any time.
 * A read from another chain could show another listing's terms under the same id.
 */
export async function chainReader() {
  if (!CONFIG.contract || !CONFIG.chainId) throw new WalletError('notConfigured');
  if (!reader) {
    if (CONFIG.rpcUrl) reader = new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true, pollingInterval: POLL_MS });
    else if (hasWallet()) {
      reader = new BrowserProvider(window.ethereum, undefined, { pollingInterval: POLL_MS });
      // a provider is bound to its network: after a chain change, make a new one
      window.ethereum.on?.('chainChanged', () => { reader = null; });
    } else throw new WalletError('none');
  }
  if (!CONFIG.rpcUrl || !readerChecked) {
    await verifyChain(reader, CONFIG.chainId);
    if (CONFIG.rpcUrl) readerChecked = true;
  }
  return reader;
}

/** StakeAttestation at the configured address, on `runner`: a chainReader() or a wallet's signer or provider. */
export function stakeAttestation(runner) {
  if (!CONFIG.contract) throw new WalletError('notConfigured');
  return new Contract(CONFIG.contract, STAKE_ATTESTATION_ABI, runner);
}

/**
 * The chain's time: the latest block's timestamp (the contract's clock, not the browser's). Asked
 * with a raw eth_getBlockByNumber: ethers shares identical getBlock() calls made within 250 ms,
 * and a time read just before a new block must not stand in for one read just after it.
 */
export async function chainNow(provider) {
  const block = await provider.send('eth_getBlockByNumber', ['latest', false]);
  return BigInt(block.timestamp);
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
