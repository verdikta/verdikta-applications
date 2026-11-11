// The indexer (node P4b1): every event of the StakeAttestation deployment, from its deployment
// block, into the store, as the bounty program's indexers do (example-bounty-program/server).
//
// - Confirmations. It reads only up to head - SA_CONFIRMATIONS.
// - Cursor. Reading goes in chunks of SA_LOG_CHUNK_BLOCKS, and each chunk is committed with the
//   new cursor (the last block read, with its hash) in one atomic write, so a process that dies
//   mid-sync leaves a consistent prefix and the next one resumes after it.
// - Reorgs. A block hash commits to every block before it, so each sync first compares the
//   cursor's stored hash with the chain's. If they differ, the indexer walks back through the
//   checkpoints it kept (the blocks it read within SA_REORG_WINDOW_BLOCKS of the cursor) to the
//   newest one still on the chain, drops every event after it, and re-reads from there; with no
//   checkpoint left on the chain it re-reads from the deployment block. A chunk is committed
//   only if the chain did not move under it: its first block's parent is the cursor, each log's
//   block hash is the chain's, and its last block's hash is the same before and after the read.
// - A listing's terms (node P18). A Listed event names the artifact only; the windows, the award
//   table and the two values erratum E8 and E9 copy onto it (its narrow-INVALID floor and its
//   confirmation size) are fixed at list() and in getListing alone. So each Listed event is stored
//   with `terms`, read once at the event's own block by its hash (EIP-1898), committed with its
//   chunk and dropped with it on a reorg. The projection derives each claim's appeal window and
//   confirmation deadline from them; nothing else of the stored event changes.
import { stakeAttestation } from '../chain/abi.js';
import { eventArgsJson, outputJson } from '../chain/codec.js';
import { readerAt } from '../chain/read.js';

export class IndexerError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'IndexerError';
    this.code = code;
  }
}

const checkpointOf = (b) => ({ number: b.number, hash: b.hash, timestamp: b.timestamp });

/** What a listing fixed at list(), as getListing has it: the terms the projection needs. */
export function listingTerms(l) {
  return {
    disputeWindow: Number(l.disputeWindow),
    revealWindow: Number(l.revealWindow),
    awards: [...l.awards],
    lowestClassCounted: l.lowestClassCounted,
    narrowInvalidFloor: l.narrowInvalidFloor,
    confirmAboveWei: l.confirmAboveWei,
  };
}

/**
 * @param {object} o
 * @param {import('ethers').Provider} o.provider
 * @param {import('./store.js').StateStore} o.store
 * @param {object} o.chain - config.chain
 * @param {object} o.logger
 */
export function createIndexer({ provider, store, chain, logger }) {
  let hasCode = false;

  /** A listing's fixed terms at its Listed block, by the block's hash: a block a reorg orphaned fails the read. */
  async function termsAt(listingId, blockNumber, blockHash) {
    let l;
    try {
      l = outputJson('getListing', (await readerAt(provider, stakeAttestation, chain.address, blockHash)('getListing', [listingId]))[0]);
    } catch (err) {
      const b = await provider.getBlock(blockNumber);
      if (!b || b.hash !== blockHash) throw new IndexerError('REORG_RETRY', `block ${blockNumber} changed while listing ${listingId} was read`);
      throw new IndexerError('LISTING_TERMS_UNREADABLE', `listing ${listingId} could not be read at block ${blockNumber} (${err?.code ?? 'error'})`);
    }
    return listingTerms(l);
  }

  async function mustBlock(number) {
    const b = await provider.getBlock(number);
    if (!b) throw new IndexerError('REORG_RETRY', `block ${number} is not on the chain any more`);
    return b;
  }

  /**
   * The endpoint is asked for its chain id on every sync (eth_chainId itself: a provider built
   * with a static network answers getNetwork() from its config), and the contract's code once.
   */
  async function verifyDeployment() {
    const id = typeof provider.send === 'function' ? BigInt(await provider.send('eth_chainId', [])) : (await provider.getNetwork()).chainId;
    if (Number(id) !== chain.chainId) throw new IndexerError('WRONG_CHAIN', `the provider is on chain ${id}, not ${chain.chainId}`);
    if (hasCode) return;
    const code = await provider.getCode(chain.address);
    if (!code || code === '0x') throw new IndexerError('NO_CONTRACT', `${chain.address} holds no contract on chain ${chain.chainId}`);
    hasCode = true;
  }

  /** Walks back to the newest checkpoint still on the chain and drops everything after it. */
  async function rollBack() {
    const { cursor, checkpoints } = store.state;
    let fork = null;
    for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
      const b = await provider.getBlock(checkpoints[i].number);
      if (b && b.hash === checkpoints[i].hash) {
        fork = checkpoints[i];
        break;
      }
    }
    store.transact((s) => {
      if (fork) {
        s.events = s.events.filter((e) => e.blockNumber <= fork.number);
        s.checkpoints = s.checkpoints.filter((c) => c.number <= fork.number);
        s.cursor = { ...fork };
      } else {
        s.events = [];
        s.checkpoints = [];
        s.cursor = null;
      }
    });
    const rolledBack = { from: cursor.number, to: fork ? fork.number : chain.fromBlock - 1, reindexed: !fork };
    logger.warn(`indexer: reorg below block ${cursor.number}; ${fork ? `rolled back to block ${fork.number}` : `no stored block is on the chain any more, re-reading from block ${chain.fromBlock}`}`);
    return rolledBack;
  }

  async function readChunk(from, to, previous) {
    const last = await mustBlock(to);
    const blocks = new Map([[last.number, last]]);
    if (previous) {
      const first = from === to ? last : await mustBlock(from);
      if (first.parentHash !== previous.hash) throw new IndexerError('REORG_RETRY', `block ${from} does not follow the cursor`);
      blocks.set(first.number, first);
    }
    const logs = await provider.getLogs({ address: chain.address, fromBlock: from, toBlock: to });
    const events = [];
    for (const log of logs) {
      if (log.removed) throw new IndexerError('REORG_RETRY', `a log of block ${log.blockNumber} was removed`);
      let block = blocks.get(log.blockNumber);
      if (!block) {
        block = await mustBlock(log.blockNumber);
        blocks.set(log.blockNumber, block);
      }
      if (block.hash !== log.blockHash) throw new IndexerError('REORG_RETRY', `block ${log.blockNumber} changed while it was read`);
      let parsed;
      try {
        parsed = stakeAttestation.parseLog({ topics: log.topics, data: log.data });
      } catch {
        parsed = null;
      }
      if (!parsed) {
        logger.warn(`indexer: a log at ${log.transactionHash}:${log.index} matches no StakeAttestation event; skipped`);
        continue;
      }
      const event = {
        name: parsed.name,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        logIndex: log.index,
        txHash: log.transactionHash,
        timestamp: block.timestamp,
        args: eventArgsJson(parsed),
      };
      events.push(event);
    }
    const again = await provider.getBlock(to);
    if (!again || again.hash !== last.hash) throw new IndexerError('REORG_RETRY', `block ${to} changed while the range was read`);
    for (const e of events) {
      if (e.name === 'Listed') e.terms = await termsAt(e.args.listingId, e.blockNumber, e.blockHash);
    }
    events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    // every header read here is on the chain that ends at `to` (whose hash did not change), so
    // each is a place a later rollback can stop at
    const seen = [...blocks.values()].map(checkpointOf).sort((a, b) => a.number - b.number);
    return { events, last, seen };
  }

  /**
   * One pass: verify, detect and undo a reorg, read up to the confirmed head.
   * @returns {Promise<{ head: number, safeHead: number, from: number|null, added: number, rolledBack: object|null, cursor: object|null }>}
   */
  async function sync() {
    await verifyDeployment();
    const head = await provider.getBlockNumber();
    const safeHead = head - chain.confirmations;
    let rolledBack = null;
    const { cursor } = store.state;
    if (cursor) {
      const b = await provider.getBlock(cursor.number);
      // a node behind the cursor (a lagging or load-balanced RPC) is not a reorg: wait for it
      if (!b) return { head, safeHead, from: null, added: 0, rolledBack: null, cursor };
      if (b.hash !== cursor.hash) rolledBack = await rollBack();
    }
    let added = 0;
    const start = store.state.cursor ? store.state.cursor.number + 1 : chain.fromBlock;
    for (let from = start; from <= safeHead; from += chain.chunkBlocks) {
      const to = Math.min(safeHead, from + chain.chunkBlocks - 1);
      const { events, last, seen } = await readChunk(from, to, store.state.cursor);
      store.transact((s) => {
        s.events.push(...events);
        s.cursor = checkpointOf(last);
        const floor = last.number - chain.reorgWindowBlocks;
        s.checkpoints = [...s.checkpoints, ...seen].filter((c) => c.number >= floor);
      });
      added += events.length;
    }
    return { head, safeHead, from: start <= safeHead ? start : null, added, rolledBack, cursor: store.state.cursor };
  }

  return { sync };
}
