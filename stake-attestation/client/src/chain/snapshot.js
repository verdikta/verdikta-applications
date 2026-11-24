// One read of the chain is of one block, and a block is its hash, never its number (node P42).
//
// A node can replace the block it had at a height while a page is reading. Calls that share only a block number can
// then answer for two chains between them: the listing of one and the hold of the other. So every contract read of
// the listing's page goes through `snapshot`, which holds the calls of one read to one block hash. It takes the latest
// block, hands the calls that block's number, and takes their answers only when the block at that number still has
// the hash it had before them. Otherwise it reads again, a small fixed number of times, and then fails: a page then
// says the listing could not be read, never what two chains said between them. A node is taken to answer truly for a
// block hash it names.
//
// The snapshot carries its block's number, hash and time, and the hash its chain has at each height the caller names:
// a receipt the page keeps stands only while its block is that chain's (lib/seenMined.js).

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

/**
 * @template T
 * @param {{ send(method: string, params: unknown[]): Promise<any> }} provider - the site's reader, or a wallet's provider
 * @param {(at: { blockTag: number }) => Promise<T>} read - the calls of this read; every one of them takes `at` as its
 *        overrides, and nothing else names a block
 * @param {object} [o]
 * @param {number[]} [o.heights] - heights whose hash on this block's chain the caller wants: a kept receipt's block
 * @returns {Promise<{ value: T, block: number, blockHash: string, time: bigint, hashes: Record<number, string|null> }>}
 *          `hashes` has each height asked for that is not above `block`. Rejects with the read's own error when the
 *          read failed on a block that kept its hash, and with SnapshotError when no try was of one block.
 */
export async function snapshot(provider, read, { heights = [], tries = SNAPSHOT_TRIES } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const head = await header(provider, 'latest');
    const blockHash = hashOf(head);
    const block = Number(head?.number);
    if (blockHash === null || !Number.isSafeInteger(block)) throw new Error('the node did not answer with its latest block');
    let value;
    let failure = null;
    try {
      value = await read({ blockTag: block });
    } catch (err) {
      // a read that failed while its block was being replaced is read again; one that failed on a block that stood, fails
      failure = err ?? new Error('the read failed');
    }
    const hashes = {};
    for (const height of new Set(heights)) {
      if (height === block) hashes[height] = blockHash;
      else if (height < block) hashes[height] = hashOf(await header(provider, height));
    }
    // the block at that number, asked again after the calls: the same hash, and every answer above is that block's
    if (hashOf(await header(provider, block)) === blockHash) {
      if (failure) throw failure;
      return { value, block, blockHash, time: BigInt(head.timestamp), hashes };
    }
  }
  throw new SnapshotError(tries);
}
