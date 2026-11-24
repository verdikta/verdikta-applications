// One read of the chain is of one block, and a block is its hash, never its number (node P42).
//
// A node can replace the block it had at a height while a page is reading, and an endpoint can be several nodes that
// do not agree on the block at a height. Calls that share only a block number can then answer for two chains between
// them: the listing of one and the hold of the other. So every contract read of the listing's page goes through
// `snapshot`, which holds the calls of one read to one block hash:
//   - it takes the latest block, and hands the read a runner on which every call is made at that block's hash (an
//     EIP-1898 block parameter, with requireCanonical): a node that does not have that block as the chain's refuses
//     the call, and the read fails;
//   - a node that does not take a block hash on a call (it refuses the parameter itself, and answers by number) is
//     asked by the block's number instead. Its answers at a number are then taken to be of the block it named at
//     that number, which the next step holds it to. Any other failure of a call made at a hash is a failed read:
//     nothing is read by number in its place;
//   - in both cases the answers are taken only when the block at that number still has the hash it had before the
//     calls. Otherwise the read is made again, a small fixed number of times, and then it fails: a page then says the
//     listing could not be read, never what two chains said between them.
// A node is taken to answer truly for a block hash it names.
//
// The snapshot carries its block's number, hash and time, and the hash its chain has at each height the caller names:
// a receipt the page keeps stands only while its block is that chain's (lib/seenMined.js).
import { refusedByContract } from '../lib/hold.js';

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

const quantity = (n) => `0x${n.toString(16)}`;
/** A block's header by tag or number, with a raw call: ethers shares and caches getBlock() and getBlockNumber(). */
const header = (provider, tag) => provider.send('eth_getBlockByNumber', [typeof tag === 'number' ? quantity(tag) : tag, false]);
/** A block hash as a node gives it, in lower case; null for anything that is not 32 bytes of hex: it is evidence of nothing. */
const asHash = (value) => (typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null);
const hashOf = (block) => asHash(block?.hash);

/** Every text of a node's error, nested ones included (a wallet wraps its node's answer). */
function textsOf(value, depth = 0) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || depth > 4) return [];
  return Object.values(value).flatMap((v) => textsOf(v, depth + 1));
}
/**
 * Whether a node's refusal of a call is about the block of that hash: it took the hash, and does not have that block
 * as the chain's. Anything a node says of a block being unknown, not found or not canonical is this, whatever else
 * the message says: it is never taken for a node that does not take a hash.
 */
const ABOUT_THE_BLOCK = /canonical|not found|unknown block|could not be found|no such block|missing (?:block|header|trie)|pruned|reorg|invalid block tag 0x[0-9a-f]{64}/i;
const saysBlockUnknown = (err) => textsOf([err?.message, err?.info?.error]).some((t) => ABOUT_THE_BLOCK.test(t));
/**
 * Whether a node's refusal of a call is of the block parameter's form itself: it does not know a block given as an
 * object with a hash. Only what says exactly that counts: JSON-RPC's own code for parameters it could not read
 * (-32602), or the words nodes and wallets have for it (a value they could not unmarshal into a block number, a
 * string method called on the object). A refusal that says anything of the block, and every other failure (a limit,
 * a timeout, an "invalid input" of unknown cause), shows nothing about hashes: it is a failed read, and the next
 * read asks by hash again.
 */
const INVALID_PARAMS = -32602;
const FORM_WORDS = /cannot unmarshal|is not a function|invalid params|invalid argument \d/i;
const refusesTheForm = (err) => !saysBlockUnknown(err)
  && (Number(err?.info?.error?.code) === INVALID_PARAMS || textsOf([err?.message, err?.info?.error]).some((t) => FORM_WORDS.test(t)));

/** Whether a provider's node takes a block hash on a call: true or false once known. */
const takesHash = new WeakMap();

/**
 * One try's calls, each made at `selector`. `at` is a contract runner: a contract made on it (chain/wallet.js
 * stakeAttestation) reads at this block and at no other, and can send nothing.
 * @returns {Promise<{ value?: unknown, failure: unknown, answered: boolean, formRefused: boolean }>} `answered`: the
 *          node ran at least one call at that block (it answered, or the contract reverted); `formRefused`: at least
 *          one call was refused for the block parameter itself
 */
async function callsAt(provider, read, selector) {
  const seen = { answered: false, formRefused: false };
  const at = Object.freeze({
    async call(tx) {
      try {
        const result = await provider.send('eth_call', [{ to: tx.to, data: tx.data ?? '0x', ...(tx.from ? { from: tx.from } : {}) }, selector]);
        seen.answered = true;
        return result;
      } catch (err) {
        if (refusedByContract(err)) seen.answered = true;
        else if (refusesTheForm(err)) seen.formRefused = true;
        throw err;
      }
    },
  });
  try {
    return { value: await read(at), failure: null, ...seen };
  } catch (err) {
    return { failure: err ?? new Error('the read failed'), ...seen };
  }
}

/**
 * @template T
 * @param {{ send(method: string, params: unknown[]): Promise<any> }} provider - the site's reader, or a wallet's provider
 * @param {(at: { call: Function }) => Promise<T>} read - the calls of this read, each made on a contract of `at`:
 *        nothing in a read names a block, and nothing outside one reads
 * @param {object} [o]
 * @param {number[]} [o.heights] - heights whose hash on this block's chain the caller wants: a kept receipt's block
 * @returns {Promise<{ value: T, block: number, blockHash: string, time: bigint, hashes: Record<number, string> }>}
 *          `hashes` has each height asked for that is not above `block` and whose header the node gave. Rejects with
 *          the read's own error when the read failed on a block that kept its hash, and with SnapshotError when no
 *          try was of one block.
 */
export async function snapshot(provider, read, { heights = [], tries = SNAPSHOT_TRIES } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const head = await header(provider, 'latest');
    const blockHash = hashOf(head);
    const block = Number(head?.number);
    if (blockHash === null || !Number.isSafeInteger(block)) throw new Error('the node did not answer with its latest block');
    let got;
    if (takesHash.get(provider) === false) got = await callsAt(provider, read, quantity(block));
    else {
      got = await callsAt(provider, read, { blockHash, requireCanonical: true });
      if (got.answered) takesHash.set(provider, true);
      else if (got.formRefused && takesHash.get(provider) === undefined) {
        // Not one call at the block's hash was run, and the node refused the parameter itself: it may not take a
        // hash. Asked by the number; if it answers that, it is such a node, for this read and those after.
        const byNumber = await callsAt(provider, read, quantity(block));
        if (byNumber.answered) {
          takesHash.set(provider, false);
          got = byNumber;
        }
      }
    }
    const hashes = {};
    for (const height of new Set(heights)) {
      // The hash this chain has at a height below the block: the block's own parent hash for the one just below it,
      // and for an older one the header the node gives by number. A header the node does not give, gives without a
      // 32-byte hash, or fails to give says nothing of that height: it is left out, the listing's read stands
      // without it, and the next read asks again.
      let at = null;
      if (height === block) at = blockHash;
      else if (height === block - 1 && asHash(head.parentHash)) at = asHash(head.parentHash);
      else if (height < block) at = hashOf(await header(provider, height).catch(() => null));
      if (at !== null) hashes[height] = at;
    }
    // the block at that number, asked again after the calls: the same hash, and every answer above is that block's
    if (hashOf(await header(provider, block)) === blockHash) {
      // a read that failed while its block was being replaced is read again; one that failed on a block that stood, fails
      if (got.failure) throw got.failure;
      return { value: got.value, block, blockHash, time: BigInt(head.timestamp), hashes };
    }
  }
  throw new SnapshotError(tries);
}
