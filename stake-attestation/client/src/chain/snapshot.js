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
const hashOf = (block) => (typeof block?.hash === 'string' ? block.hash.toLowerCase() : null);

/** Every text of a node's error, nested ones included (a wallet wraps its node's answer). */
function textsOf(value, depth = 0) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || depth > 4) return [];
  return Object.values(value).flatMap((v) => textsOf(v, depth + 1));
}
/**
 * Whether a node's refusal of a call says it does not have the block of that hash as the chain's: it took the hash,
 * and has no such block.
 */
const BLOCK_UNKNOWN = /not currently canonical|header (?:for hash )?not found|unknown block|block[^.]{0,90}not found|could not be found|invalid block tag 0x[0-9a-f]{64}/i;
const saysBlockUnknown = (err) => textsOf([err?.message, err?.info?.error]).some((t) => BLOCK_UNKNOWN.test(t));
/**
 * Whether a node's refusal of a call is of the block-hash parameter itself: it does not know that form of a block
 * (JSON-RPC's invalid-request, method and params codes, or a node's or a wallet's own words for a parameter it could
 * not read). A node that fails for any other reason (a limit, a timeout) has said nothing about hashes.
 */
const FORM_CODES = new Set([-32700, -32600, -32601, -32602]);
const FORM_WORDS = /invalid (?:argument|params?|parameters?|block|input|request)|unmarshal|deserializ|pars(?:e|ing)|decod(?:e|ing)|hex string|unsupported|not supported|is not a function|malformed/i;
const refusesTheForm = (err) => !saysBlockUnknown(err)
  && (FORM_CODES.has(Number(err?.info?.error?.code)) || textsOf([err?.message, err?.info?.error]).some((t) => FORM_WORDS.test(t)));

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
      // a header the node does not give says nothing of that height: it is left out, and asked again by the next read
      const at = height === block ? blockHash : height < block ? hashOf(await header(provider, height)) : null;
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
