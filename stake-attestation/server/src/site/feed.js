// The listing feed (design §15): what a hunter needs to choose a listing, for every listing that
// takes commits at the indexed block. Candidates are the listings the events say opened, have not
// rolled forward or closed, and are not held by their maker (below); each is then read on-chain at
// that block, and kept only while it is Open and its paid period has not ended (a lapsed listing
// stays Open for its pending claims but leaves the feed, §13.1). Which of them the site offers (those that count) is decided when the
// answer is made (site/index.js, src/control/counting.js), as the proofs change between blocks. Its identity (repo, commit) comes from its Listed event, its image
// and scope from its listing archive (archives.js), everything else from getListing.
//
// Node P35 adds two fields and changes none: disclosureRecipient, the age recipient of disclosureKey's 32 bytes
// (shared/src/disclosureKey.js), and sameRepository, the other listings of the entry's repository that opened
// (sameRepository.js), each read at the same block.
//
// Tester bounty 400 (2026-11) adds two more, and changes none: pendingClaims, how many claims on the listing are
// neither settled nor expired, and headClaim, the earliest of them (null when there is none). Claims on a listing
// reveal in commit order (decision D5; ClaimLogic.revealDeadline), so these are the claims a new one would wait
// behind, and a hunter had no way to see them before paying. Every claim in an entry's queue is one of pendingClaims:
// no entry has ever taken a late claim (below).
//
// The maker's hold (node P40; owner, 2026-11-23; StakeAttestation.hold). A held listing stays Open or Depleted for its
// pending claims, takes no commit and takes late claims instead (acceptsCommits, acceptsLateClaims), so it is not an
// entry, as a lapsed one is not: the projection's heldAt says so, from the indexed Held event, at the answer's block.
// No call is made for it, so a contract from before the hold, which has no such event and no heldAt view, answers as
// it did. That is also why the queue fields still mean what they say. A late claim is taken only on a Rolled, a Closed
// or a held listing, and none of the three is ever an entry again: Rolled and Closed are final, and a hold has no
// resume (it ends only in a roll forward or a close). So an entry has never taken a late claim, and every claim in its
// queue is one of pendingClaims, each ahead of a claim committed now. Had a held listing stayed an entry, its headClaim
// could name a late claim, which pendingClaims does not count.
import { disclosureRecipientOf } from '@verdikta/stake-attestation-shared/disclosure-key';

import { SEVERITY_CLASSES } from '../chain/abi.js';
import { outputJson } from '../chain/codec.js';
import { listingLabels } from '../record/labels.js';
import { archiveFields } from './archives.js';
import { sameRepository, stateAt, stateReader } from './sameRepository.js';

const DAY = 86400;

/**
 * @param {object} o
 * @param {(fn: string, args: unknown[]) => Promise<import('ethers').Result>} o.read - the contract at `block`
 * @param {object} o.projection - of the events up to `block`
 * @param {{ number: number, hash: string, timestamp: number }} o.block - the indexed block
 * @param {Record<string, object>} o.archives - store.state.archives
 * @param {object} o.labels - { price, badgeFloorWei, underStakedRatioBps }
 * @param {number} o.discloseWindow - the contract's DISCLOSE_WINDOW
 */
export async function buildFeed({ read, projection, block, archives, labels, discloseWindow }) {
  const candidates = [...projection.listings.values()].filter((l) => l.opened && !l.rolled && !l.closed && l.heldAt === null);
  const entries = [];
  const states = new Map();
  for (const l of candidates) {
    const onchain = outputJson('getListing', (await read('getListing', [l.listingId]))[0]);
    const fundedUntil = Number(onchain.fundedUntil);
    states.set(l.listingId, stateAt(onchain, block));
    const { lapsed } = states.get(l.listingId);
    if (onchain.state !== 'Open' || lapsed || BigInt(onchain.escrowWei) < BigInt(onchain.awards[3])) continue;
    const invited = onchain.allowlist.length > 0;
    // heldAt is null here: a held listing is no candidate
    const asRecord = { listingId: l.listingId, state: onchain.state, lapsed, heldAt: l.heldAt, invited, awards: onchain.awards, valueAtRiskUsd: onchain.valueAtRiskUsd };
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
      pendingClaims: Number(onchain.pendingClaims),
      headClaim: onchain.headClaim === '0' ? null : onchain.headClaim,
      escrowRemainingWei: onchain.escrowWei,
      owedWei: onchain.owedWei,
      valueAtRiskUsd: onchain.valueAtRiskUsd,
      invited,
      labels: listingLabels(asRecord, labels),
      listingCid: onchain.listingCid,
      disputeCid: onchain.disputeCid,
      disclosureKey: onchain.disclosureKey,
      disclosureRecipient: disclosureRecipientOf(onchain.disclosureKey),
      sameRepository: [], // below, once every entry's own state is read
    });
  }
  // the other listings of each entry's repository, every state read at this block once
  const stateOf = stateReader(read, block, states);
  for (const e of entries) {
    e.sameRepository = await sameRepository({ listings: projection.listings, repo: e.artifact.repo, except: (x) => x.listingId === e.listingId, stateOf });
  }
  entries.sort((a, b) => (BigInt(b.listingId) > BigInt(a.listingId) ? 1 : -1)); // newest first
  return entries;
}
