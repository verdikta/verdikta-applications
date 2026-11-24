// The maker's wallet (an injected EIP-1193 provider) and the chain reads. Transactions go through
// the wallet only: list(), fund(), flagBadDisclosure(), release(), dispute(), hold(), rollForward(), renew(),
// close() and withdraw(). Reads use VITE_SA_RPC_URL when the
// site has one, so the check page works before a wallet is connected.
import { BrowserProvider, Contract, JsonRpcProvider } from 'ethers';

import { CONFIG } from '../config.js';
import { STAKE_ATTESTATION_ABI } from './abi.js';
import { siteReader } from './snapshot.js';

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
    // The site's read address: a snapshot asks it at a block's hash (chain/snapshot.js), and only a provider made
    // here is asked that way. Without an address, reads go through the wallet's node, by the block's number.
    if (CONFIG.rpcUrl) reader = siteReader(new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true, pollingInterval: POLL_MS }));
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

/**
 * StakeAttestation at the configured address, on `runner`: a chainReader() or a wallet's signer or provider, or a
 * snapshot's runner (chain/snapshot.js), to read at that snapshot's block.
 */
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

/**
 * The receipt of a transaction once it is mined, also when the wallet sent it again at a higher fee (a "speed up"):
 * the same call is then mined under another hash, and ethers rejects wait() with TRANSACTION_REPLACED and that
 * transaction's receipt. That receipt is this call's when the replacement only repriced it and it did not revert.
 * A replacement that cancelled the transaction or sent something else is not, and rejects as before.
 *
 * `onMined` is told the block of whatever was mined, before anything else is done with it: the receipt's, the
 * replacement's, or that of a transaction that reverted. A listing's page then knows that the read it shows is from
 * before that block (lib/pageSays.js), on every path that sends.
 * @param {{ wait(): Promise<object> }} tx - a sent transaction
 * @param {(block: number) => void} [onMined]
 * @returns {Promise<object>} the receipt: its `hash` is the mined transaction's
 */
export async function minedReceipt(tx, onMined = () => {}) {
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (err) {
    if (Number.isSafeInteger(err?.receipt?.blockNumber)) onMined(err.receipt.blockNumber);
    if (err?.code === 'TRANSACTION_REPLACED' && err.reason === 'repriced' && err.cancelled === false && err.receipt?.status === 1) return err.receipt;
    throw err;
  }
  onMined(receipt.blockNumber);
  return receipt;
}

/**
 * The listing as one block has it, or null when the contract has no listing of that id there. getListing reverts for
 * such an id, so the count is asked first, of the same block.
 * @param {object} contract - StakeAttestation made on a snapshot's runner (chain/snapshot.js): its calls are that block's
 * @returns {Promise<object|null>}
 */
export async function listingAt(contract, listingId) {
  const id = BigInt(listingId);
  if (id === 0n || id > BigInt(await contract.listingCount())) return null;
  return contract.getListing(id);
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
