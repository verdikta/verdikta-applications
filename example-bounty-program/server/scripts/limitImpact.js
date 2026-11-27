#!/usr/bin/env node
/**
 * Limit impact (owner runbook; review 2026-11-26 finding 19, an accepted limitation).
 *
 * BountyEscrow and StakeAttestation store each bounty's or listing's jury and check only its
 * structure; the aggregator checks every request against its LIVE, owner-set limits (maxJury,
 * maxTimeout, tPlus: ReputationAggregator.setLimits; the keeper's shortlistSize:
 * ReputationKeeper.setSelection). Tightening one strands every live bounty or listing whose jury
 * then fails it: its starts and reveals revert. The owner is trusted to act benevolently; this
 * script is the check before such a change. It reads only (no key), and lists:
 *   - Open bounties before their deadline, and Open or Depleted listings (or ones with claims
 *     pending), whose jury passes the CURRENT limits but would fail the PROPOSED ones;
 *   - those that already fail the current limits (for information).
 * Exit code 0 when the proposed limits strand nothing, 2 when they would.
 *
 * Usage:
 *   node scripts/limitImpact.js --rpc <url> --aggregator <addr> \
 *     [--escrow <addr>]... [--attestation <addr>]... \
 *     [--max-jury N] [--max-timeout S] [--t-plus S] [--shortlist N]
 * An omitted proposed value keeps the current one. Example, before raising T+ to 200 s:
 *   node scripts/limitImpact.js --rpc $RPC --aggregator $AGG --escrow $ESCROW --attestation $SA --t-plus 200
 */

const { ethers } = require('ethers');
const escrowAbi = require('../../onchain/abi/BountyEscrow.json');
const attestationAbi = require('../../../stake-attestation/server/src/chain/abi/StakeAttestation.json');

const MAX_TIMEOUT = 86400;   // AggregatorLib.MAX_TIMEOUT: one day, whatever maxTimeout says
const AGGREGATOR_ABI = [
  'function maxJury() view returns (uint8)',
  'function maxTimeout() view returns (uint40)',
  'function tPlus() view returns (uint40)',
  'function keeper() view returns (address)',
];
const KEEPER_ABI = ['function shortlistSize() view returns (uint16)'];

/**
 * Why a request with this jury fails these limits, or '' (the lenses' juryProblem, same order
 * and wording). limits: { maxJury, maxTimeout, tPlus, shortlist }; jury: { K, timeout }.
 */
function juryProblemUnder(limits, jury) {
  const t = Number(jury.timeout), K = Number(jury.K);
  if (t <= Number(limits.tPlus)) return 'timeout at or below tPlus';
  if (t > Number(limits.maxTimeout)) return 'timeout above maxTimeout';
  if (t > MAX_TIMEOUT) return 'timeout above one day';
  if (K > Number(limits.maxJury)) return 'K above maxJury';
  if (limits.shortlist != null && K > Number(limits.shortlist)) return "K above the keeper's shortlist";
  return '';
}

/**
 * Split live items by what the change does to them. items: [{ kind, id, jury }].
 * @returns {{ stranded: object[], alreadyFailing: object[] }} each item with `reason`
 */
function impactOf(current, proposed, items) {
  const stranded = [], alreadyFailing = [];
  for (const item of items) {
    const now = juryProblemUnder(current, item.jury);
    if (now) { alreadyFailing.push({ ...item, reason: now }); continue; }
    const after = juryProblemUnder(proposed, item.jury);
    if (after) stranded.push({ ...item, reason: after });
  }
  return { stranded, alreadyFailing };
}

async function currentLimits(provider, aggregator) {
  const agg = new ethers.Contract(aggregator, AGGREGATOR_ABI, provider);
  const [maxJury, maxTimeout, tPlus, keeper] = await Promise.all([agg.maxJury(), agg.maxTimeout(), agg.tPlus(), agg.keeper()]);
  const shortlist = await new ethers.Contract(keeper, KEEPER_ABI, provider).shortlistSize();
  return { maxJury: Number(maxJury), maxTimeout: Number(maxTimeout), tPlus: Number(tPlus), shortlist: Number(shortlist) };
}

/** Open bounties before their deadline: they can still take a start. */
async function liveBounties(provider, address, now) {
  const escrow = new ethers.Contract(address, escrowAbi, provider);
  const count = Number(await escrow.bountyCount());
  const out = [];
  for (let id = 0; id < count; id++) {
    const b = await escrow.getBounty(id);
    if (Number(b.status) !== 0 || Number(b.submissionDeadline) <= now) continue;
    out.push({ kind: 'bounty', contract: address, id, deadline: Number(b.submissionDeadline), jury: { K: Number(b.juryK), timeout: Number(b.juryTimeout) } });
  }
  return out;
}

/** Listings that take commits (Open, Depleted) or still hold claims to judge. */
async function liveListings(provider, address) {
  const sa = new ethers.Contract(address, attestationAbi, provider);
  const count = Number(await sa.listingCount());
  const out = [];
  for (let id = 1; id <= count; id++) {
    const l = await sa.getListing(id);
    const state = Number(l.state);   // Listed, Open, Depleted, Rolled, Closed
    if (state !== 1 && state !== 2 && Number(l.pendingClaims) === 0) continue;
    out.push({ kind: 'listing', contract: address, id, pendingClaims: Number(l.pendingClaims), jury: { K: Number(l.oracle.jury.K), timeout: Number(l.oracle.jury.timeout) } });
  }
  return out;
}

function parseArgs(argv) {
  const a = { escrow: [], attestation: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--escrow' || k === '--attestation') { a[k.slice(2)].push(v); i++; }
    else if (k.startsWith('--')) { a[k.slice(2)] = v; i++; }
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.rpc || !a.aggregator) {
    console.error('Usage: node scripts/limitImpact.js --rpc <url> --aggregator <addr> [--escrow <addr>]... [--attestation <addr>]... [--max-jury N] [--max-timeout S] [--t-plus S] [--shortlist N]');
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(a.rpc);
  const current = await currentLimits(provider, a.aggregator);
  const proposed = {
    maxJury: a['max-jury'] ?? current.maxJury,
    maxTimeout: a['max-timeout'] ?? current.maxTimeout,
    tPlus: a['t-plus'] ?? current.tPlus,
    shortlist: a.shortlist ?? current.shortlist,
  };
  const now = (await provider.getBlock('latest')).timestamp;
  const items = [];
  for (const e of a.escrow) items.push(...await liveBounties(provider, e, now));
  for (const s of a.attestation) items.push(...await liveListings(provider, s));
  const { stranded, alreadyFailing } = impactOf(current, proposed, items);

  console.log('current  ', JSON.stringify(current));
  console.log('proposed ', JSON.stringify(proposed));
  console.log(`live items checked: ${items.length}`);
  const line = (x) => `  ${x.kind} ${x.id} (${x.contract}) K=${x.jury.K} timeout=${x.jury.timeout}s: ${x.reason}`
    + (x.deadline ? `, deadline ${new Date(x.deadline * 1000).toISOString()}` : '')
    + (x.pendingClaims ? `, ${x.pendingClaims} claims pending` : '');
  console.log(`STRANDED by the change: ${stranded.length}`);
  stranded.forEach((x) => console.log(line(x)));
  if (alreadyFailing.length) {
    console.log(`already refused under the current limits: ${alreadyFailing.length}`);
    alreadyFailing.forEach((x) => console.log(line(x)));
  }
  process.exit(stranded.length ? 2 : 0);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { juryProblemUnder, impactOf, parseArgs, currentLimits, liveBounties, liveListings, MAX_TIMEOUT };
