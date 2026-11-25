// One read of the chain is of one block, and a block is its hash, never its number (node P42).
//
// A node can replace the block it had at a height while a page is reading. Calls that share only a block number can
// then answer for two chains between them: the listing of one and the hold of the other. So what a listing's page
// says of a hold is read through `snapshot`, which holds the calls of one read to one block hash. It takes the latest
// block, hands the read a runner on which every call is made at that block, and takes the answers only when the block
// at that number still has the hash it had before the calls. Otherwise the read is made again, a small fixed number
// of times, and then it fails: a page then says the listing could not be read, never what two chains said between them.
//
// How a call names the block comes from where the provider was made, and never from what a node answers:
//   - the site's read address (chain/wallet.js chainReader): at the block's hash, an EIP-1898 block parameter with
//     requireCanonical. A node that does not have that block as the chain's refuses the call, and so does an address
//     that does not take the form: either way the read fails, and nothing is read by number in its place. The deploy
//     notes say the address must take it;
//   - a wallet's node: by the block's number. What a wallet does with a block parameter it does not know is its own,
//     so it is never sent one; its answers are held to the block by the hash before and after alone. A wallet can
//     change network at any moment, so it is also held to the site's chain: it is asked its chain after the calls of
//     every try, and a try it reported a change of network during is not taken.
// The nodes behind one address are taken to agree on the chain, and a node to answer truly for a block hash it names.
import { CONFIG } from '../config.js';
import { verifyChain } from './wallet.js';

/** How many times a read is made before it fails, when the block it was made at did not keep its hash. */
export const SNAPSHOT_TRIES = 3;

/** No read was of one block: each time, the block the calls were made at had another hash after them. */
export class SnapshotError extends Error {
  constructor(tries) {
    super(`the chain changed while it was read (${tries} tries): no read was of one block`);
    this.name = 'SnapshotError';
    this.code = 'SNAPSHOT_MOVED';
  }
}

/** The providers made for the site's read address: every call of theirs names the block by its hash. */
const SITE_READERS = new WeakSet();
/** Marks `provider` as made for the site's read address, where it is made (chain/wallet.js chainReader). */
export function siteReader(provider) {
  SITE_READERS.add(provider);
  return provider;
}

/** How many changes of network the wallet has reported (chain/wallet.js hears them, and tells them here). */
let switches = 0;
export const walletSwitched = () => { switches += 1; };

const quantity = (n) => `0x${n.toString(16)}`;
/** A block's header by tag or number, with a raw call: ethers shares and caches getBlock() and getBlockNumber(). */
const header = (provider, tag) => provider.send('eth_getBlockByNumber', [typeof tag === 'number' ? quantity(tag) : tag, false]);
/** A block's hash as a node gives it, in lower case; null for anything that is not 32 bytes of hex: it is evidence of nothing. */
const hashOf = (block) => (typeof block?.hash === 'string' && /^0x[0-9a-f]{64}$/i.test(block.hash) ? block.hash.toLowerCase() : null);

/**
 * @template T
 * @param {{ send(method: string, params: unknown[]): Promise<any> }} provider - the site's reader, or a wallet's provider
 * @param {(at: { call: Function }) => Promise<T>} read - the calls of this read, each made on a contract of `at`
 *        (chain/wallet.js stakeAttestation): such a contract reads at this block and at no other, and can send nothing
 * @returns {Promise<{ value: T, block: number, blockHash: string }>} Rejects with the read's own error when the read
 *          failed on a block that kept its hash, with SnapshotError when no try was of one block, and with wrongChain
 *          when a wallet's node is not on the site's chain (`chainId`, which only a test, having no build, passes).
 */
export async function snapshot(provider, read, { tries = SNAPSHOT_TRIES, chainId = CONFIG.chainId } = {}) {
  const ofWallet = !SITE_READERS.has(provider);
  for (let i = 0; i < tries; i += 1) {
    const reported = switches;
    const head = await header(provider, 'latest');
    const blockHash = hashOf(head);
    const block = Number(head?.number);
    if (blockHash === null || !Number.isSafeInteger(block)) throw new Error('the node did not answer with its latest block');
    const selector = SITE_READERS.has(provider) ? { blockHash, requireCanonical: true } : quantity(block);
    const at = Object.freeze({
      call: (tx) => provider.send('eth_call', [{ to: tx.to, data: tx.data ?? '0x', ...(tx.from ? { from: tx.from } : {}) }, selector]),
    });
    let value;
    let failure = null;
    try {
      value = await read(at);
    } catch (err) {
      failure = err ?? new Error('the read failed');
    }
    // the block at that number, asked again after the calls: the same hash, and every answer above is that block's
    const stood = hashOf(await header(provider, block)) === blockHash;
    // A wallet on another network by now fails the read here, whatever its blocks say: this read makes no further
    // try. A try it reported a change during is not taken either: it may have gone there and come back.
    if (ofWallet) await verifyChain(provider, chainId);
    if (stood && (!ofWallet || switches === reported)) {
      // a read that failed while its block was being replaced is read again; one that failed on a block that stood, fails
      if (failure) throw failure;
      return { value, block, blockHash };
    }
  }
  throw new SnapshotError(tries);
}
