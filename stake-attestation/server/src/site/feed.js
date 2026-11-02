// The listing feed (design §15): what a hunter needs to choose a listing, for every listing that
// takes commits at the indexed block. Candidates are the listings the events say opened and have
// not rolled forward or closed; each is then read on-chain at that block, and kept only while it
// is Open and its paid period has not ended (a lapsed listing stays Open for its pending claims
// but leaves the feed, §13.1). Its identity (repo, commit) comes from its Listed event, its image
// and scope from its listing archive (archives.js), everything else from getListing.
import { SEVERITY_CLASSES } from '../chain/abi.js';
import { outputJson } from '../chain/codec.js';
import { listingLabels } from '../record/labels.js';
import { archiveFields } from './archives.js';

const DAY = 86400;

/**
 * @param {object} o
 * @param {import('ethers').Contract} o.contract
 * @param {object} o.projection
 * @param {{ number: number, hash: string, timestamp: number }} o.block - the indexed block
 * @param {Record<string, object>} o.archives - store.state.archives
 * @param {object} o.labels - { price, badgeFloorWei, underStakedRatioBps }
 * @param {number} o.discloseWindow - the contract's DISCLOSE_WINDOW
 */
export async function buildFeed({ contract, projection, block, archives, labels, discloseWindow }) {
  const candidates = [...projection.listings.values()].filter((l) => l.opened && !l.rolled && !l.closed);
  const entries = [];
  for (const l of candidates) {
    const onchain = outputJson('getListing', await contract.getListing(l.listingId, { blockTag: block.number }));
    const fundedUntil = Number(onchain.fundedUntil);
    const lapsed = fundedUntil !== 0 && block.timestamp >= fundedUntil;
    if (onchain.state !== 'Open' || lapsed || BigInt(onchain.escrowWei) < BigInt(onchain.awards[3])) continue;
    const invited = onchain.allowlist.length > 0;
    const asRecord = { listingId: l.listingId, state: onchain.state, lapsed, invited, awards: onchain.awards, valueAtRiskUsd: onchain.valueAtRiskUsd };
    entries.push({
      listingId: l.listingId,
      artifactHash: l.artifactHash,
      artifact: { ...l.artifact },
      maker: onchain.maker,
      ...archiveFields(archives[l.listingCid], { artifact: l.artifact, disclosureKey: onchain.disclosureKey }),
      awards: Object.fromEntries(SEVERITY_CLASSES.map((c, i) => [c, onchain.awards[i]])),
      lowestClassCounted: onchain.lowestClassCounted,
      bondWei: onchain.bondWei,
      windows: {
        fixWindow: Number(onchain.fixWindow),
        disputeWindow: Number(onchain.disputeWindow),
        disclosureGrace: Number(onchain.disclosureGrace),
        revealWindow: Number(onchain.revealWindow),
        discloseWindow,
      },
      openedAt: Number(onchain.openedAt),
      fundedUntil,
      daysOpen: Math.floor((block.timestamp - Number(onchain.openedAt)) / DAY),
      claimsSoFar: Number(onchain.claimsCommitted),
      escrowRemainingWei: onchain.escrowWei,
      owedWei: onchain.owedWei,
      valueAtRiskUsd: onchain.valueAtRiskUsd,
      invited,
      labels: listingLabels(asRecord, labels),
      listingCid: onchain.listingCid,
      disputeCid: onchain.disputeCid,
      disclosureKey: onchain.disclosureKey,
    });
  }
  entries.sort((a, b) => (BigInt(b.listingId) > BigInt(a.listingId) ? 1 : -1)); // newest first
  return entries;
}
