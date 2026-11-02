// The record mirror (design §4.1, §13.4; node P4b1): recordByHash of an artifact hash at the
// indexed block, read through the lens at the contract's own address with the merged ABI, and
// written field for field as JSON (chain/codec.js). A long record is read with recordPage, a page
// of listings at a time and, within each, a window of the findings and the flags at a time, and
// assembled to exactly what recordByHash answers: the listings and `active` in order, the
// histories summed, the findings and flags concatenated, their counts summed.
import { outputJson } from '../chain/codec.js';

const HISTORY_ARRAYS = new Set(['outcomes', 'lateOutcomes']);

function addHistory(sum, h) {
  for (const [k, v] of Object.entries(h)) {
    if (HISTORY_ARRAYS.has(k)) sum[k] = sum[k] ? sum[k].map((x, i) => (BigInt(x) + BigInt(v[i])).toString()) : [...v];
    else sum[k] = sum[k] === undefined ? v : (BigInt(sum[k]) + BigInt(v)).toString();
  }
  return sum;
}

/**
 * @param {import('ethers').Contract} contract - StakeAttestation with the merged ABI
 * @param {string} artifactHash
 * @param {{ blockTag: number, listingPage: number, itemPage: number }} o
 * @returns {Promise<object>} the Record, as JSON
 */
export async function readRecord(contract, artifactHash, { blockTag, listingPage, itemPage }) {
  const page = async (lo, io) => outputJson('recordPage', await contract.recordPage(artifactHash, lo, listingPage, io, itemPage, { blockTag }));
  const first = await page(0, 0);
  const total = BigInt(first.listingCount);
  if (total <= BigInt(listingPage) && BigInt(first.findingCount) <= BigInt(itemPage) && BigInt(first.flagCount) <= BigInt(itemPage)) {
    return first; // one page holds it all: this is recordByHash's answer
  }
  const out = { ...first, active: [], listings: [], history: null, findingCount: '0', findings: [], flagCount: '0', flags: [] };
  for (let lo = 0n; lo < total; lo += BigInt(listingPage)) {
    const p = lo === 0n ? first : await page(lo, 0);
    out.active.push(...p.active);
    out.listings.push(...p.listings);
    out.history = addHistory(out.history ?? {}, p.history);
    out.findingCount = (BigInt(out.findingCount) + BigInt(p.findingCount)).toString();
    out.flagCount = (BigInt(out.flagCount) + BigInt(p.flagCount)).toString();
    out.findings.push(...p.findings);
    out.flags.push(...p.flags);
    const items = BigInt(p.findingCount) > BigInt(p.flagCount) ? BigInt(p.findingCount) : BigInt(p.flagCount);
    for (let io = BigInt(itemPage); io < items; io += BigInt(itemPage)) {
      const more = await page(lo, io);
      out.findings.push(...more.findings);
      out.flags.push(...more.flags);
    }
  }
  return out;
}
