// ETH/USD from Chainlink's aggregator on the chain (Base), for the under-staked label (design
// §4.2). Read at the block the record is read at, so a record and its labels are of one block. An
// answer that is not positive, or older than SA_ETH_USD_MAX_AGE_SECONDS at that block, is no price:
// the labels then leave a declared value at risk unlabelled rather than guess.
import { Interface } from 'ethers';

import { ETH_USD_FEED_ABI } from '../chain/abi.js';
import { readerAt } from '../chain/read.js';

const feedInterface = new Interface(ETH_USD_FEED_ABI);

export class PriceError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'PriceError';
    this.code = code;
  }
}

/**
 * @param {object} o
 * @param {import('ethers').JsonRpcApiProvider} o.provider
 * @param {string|null} o.feed - the aggregator's address (config.labels.ethUsdFeed)
 * @param {string} o.blockHash - the block read at (by hash, chain/read.js)
 * @param {number} o.at - that block's timestamp
 * @param {number} o.maxAgeSeconds
 * @returns {Promise<{ answer: string, decimals: number, updatedAt: number, roundId: string, feed: string }>}
 * @throws {PriceError} ETH_USD_NOT_CONFIGURED, ETH_USD_UNREADABLE, ETH_USD_INVALID, ETH_USD_STALE
 */
export async function readEthUsd({ provider, feed, blockHash, at, maxAgeSeconds }) {
  if (!feed) throw new PriceError('ETH_USD_NOT_CONFIGURED', 'SA_ETH_USD_FEED names no aggregator');
  const read = readerAt(provider, feedInterface, feed, blockHash);
  let decimals;
  let round;
  try {
    [[decimals], round] = await Promise.all([read('decimals'), read('latestRoundData')]);
  } catch (err) {
    throw new PriceError('ETH_USD_UNREADABLE', `the aggregator at ${feed} did not answer (${err?.code ?? 'error'})`);
  }
  const answer = round.answer;
  const updatedAt = Number(round.updatedAt);
  if (answer <= 0n || updatedAt === 0 || Number(decimals) > 36) throw new PriceError('ETH_USD_INVALID', 'the aggregator\'s answer is not a price');
  if (at - updatedAt > maxAgeSeconds) throw new PriceError('ETH_USD_STALE', `the answer is ${at - updatedAt} s old (at most ${maxAgeSeconds})`);
  return { answer: answer.toString(), decimals: Number(decimals), updatedAt, roundId: round.roundId.toString(), feed };
}
