// A listing as the tool may use it. Everything the tool relies on from an archive is checked against what the
// arbiters check and what the chain stores:
//
//   the signature        shared's didBuilderSign over both archives, with common's validators, as the site
//   the artifact         the contract's own artifactHashOf of the archive's repo and commit against the
//                        listing's hash (the repo and commit themselves are only in an event)
//   the disclosure key   on-chain against the archive's: arbiters check against the archive's, so a hunter who
//                        encrypted to another key would lose the bond at the gate (owner Q36)
//   the terms            the signed stake against getListing, the site's ARCHIVE_MISMATCH rule
//
// It does not check that the on-chain maker is the address the repository's proof names: that takes a git host,
// the site does it, and a replay with the same key stays open as accepted for testnet (owner Q36). The notice
// says so.
import { didBuilderSign, readSignedListing } from '@verdikta/stake-attestation-shared/builder-signature';
import { readZipMember, zipDirectory } from '@verdikta/stake-attestation-shared/zip-read';
import { ZeroAddress } from 'ethers';

import { LISTING_STATES, OUTCOMES } from './abi.js';
import { codeReview } from './common.js';
import { fail, ToolError } from './errors.js';
import { gatewayGet, isRawSha256Cid, rawCid } from './ipfs.js';

const MAX_LISTING_BYTES = 64 * 1024 * 1024;
const MEMBER_MAX_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The archive at a CID: a raw CID's bytes must hash to it. */
export async function fetchArchive(ctx, cid, { maxBytes = MAX_LISTING_BYTES } = {}) {
  if (!ctx.gateway) throw fail('USAGE', 'This needs VERDIKTA_IPFS_GATEWAY.');
  let bytes;
  try {
    bytes = await gatewayGet(ctx.gateway, cid, { maxBytes, fetchImpl: ctx.fetch });
  } catch (err) {
    if (err?.why === 'too-large') throw fail('ARCHIVE_TOO_LARGE');
    throw fail('ARCHIVE_UNAVAILABLE', cid);
  }
  if (isRawSha256Cid(cid) && rawCid(bytes) !== cid) throw fail('ARCHIVE_NOT_CID', cid);
  return bytes;
}

function memberJson(bytes, name) {
  const entries = zipDirectory(bytes);
  const entry = entries.get(name);
  if (!entry) return null;
  return JSON.parse(utf8.decode(readZipMember(bytes, entry, MEMBER_MAX_BYTES)));
}

/** What a run needs from a listing archive: the spec, the attestation, the baseline, the known issues. */
export function runnerFilesOf(bytes, spec) {
  try {
    return {
      attestation: memberJson(bytes, spec.attestation ?? codeReview.ATTESTATION_FILE),
      baseline: memberJson(bytes, spec.baseline ?? codeReview.BASELINE_FILE),
      knownIssues: spec.stake?.knownIssues ? memberJson(bytes, spec.stake.knownIssues) ?? [] : [],
    };
  } catch {
    throw fail('LISTING_ARCHIVE_INVALID');
  }
}

const devKeysOf = (ctx) => (ctx.devKeys?.length ? ctx.devKeys : null);

function artifactOf(spec) {
  const a = spec.artifact ?? { kind: 'repo' };
  return a.kind === 'contract'
    ? { kind: 1, repo: spec.repo, baseCommit: spec.baseCommit, chainId: BigInt(a.chainId), addr: String(a.address).toLowerCase() }
    : { kind: 0, repo: spec.repo, baseCommit: spec.baseCommit, chainId: 0n, addr: ZeroAddress };
}

function termsMatch(spec, knownIssues, l) {
  const eff = codeReview.effectiveStake(spec);
  const awards = codeReview.awardsToWei(spec.stake.awards);
  const ids = (knownIssues ?? []).map((k) => `0x${String(k.id).slice('sha256:'.length)}`.toLowerCase()).sort();
  const onChainIds = [...l.knownIssueIds].map((x) => x.toLowerCase()).sort();
  return codeReview.SEVERITY_CLASSES.every((c, i) => awards[c] === l.awards[i])
    && spec.stake.lowestClassCounted === OUTCOMES[Number(l.lowestClassCounted)]
    && BigInt(spec.stake.bondWei) === l.bondWei
    && BigInt(eff.fixWindowDays * 86400) === l.fixWindow
    && BigInt(eff.disputeWindowHours * 3600) === l.disputeWindow
    && BigInt(eff.disclosureGraceHours * 3600) === l.disclosureGrace
    && BigInt(eff.revealWindowDays * 86400) === l.revealWindow
    && BigInt(spec.stake.valueAtRiskUsd ?? 0) === l.valueAtRiskUsd
    && ids.length === onChainIds.length && ids.every((x, i) => x === onChainIds[i]);
}

/**
 * Reads a listing from the chain and its archives through the gateway.
 * @returns {Promise<object>} with `refusal`: why a commit is refused (a code), or null
 */
export async function inspectListing(ctx, listingId) {
  let l;
  try {
    l = await ctx.read('getListing', [listingId]);
  } catch (err) {
    if (err.code === 'CONTRACT_REFUSED' && /bad listingId/.test(err.message)) throw fail('LISTING_NOT_FOUND', `Listing ${listingId}.`);
    throw err;
  }
  const listingBytes = await fetchArchive(ctx, l.listingCid);
  const disputeBytes = await fetchArchive(ctx, l.disputeCid);
  const read = readSignedListing(listingBytes, { codeReview, devKeys: devKeysOf(ctx) });
  const { spec, knownIssues } = read;
  const base = { listingId: BigInt(listingId), onChain: l, listingBytes, listingCid: l.listingCid, spec, knownIssues };
  if (!read.signed) return { ...base, refusal: read.reason };

  const hash = await ctx.read('artifactHashOf', [artifactOf(spec)]).catch((err) => {
    if (err instanceof ToolError && err.code === 'RPC_UNAVAILABLE') throw err;
    return null;
  });
  if (hash !== l.artifactHash) return { ...base, refusal: 'ARCHIVE_MISMATCH' };
  const signed = didBuilderSign({
    listingBytes,
    disputeBytes,
    codeReview,
    listing: { repo: spec.repo, baseCommit: spec.baseCommit, disclosureKey: l.disclosureKey },
    devKeys: devKeysOf(ctx),
  });
  if (!signed.signed) return { ...base, refusal: signed.reason };
  if (!termsMatch(spec, knownIssues, l)) return { ...base, refusal: 'ARCHIVE_MISMATCH' };
  return { ...base, refusal: null, trust: signed.trust, keyId: signed.keyId };
}

/** A listing a commit may go on. @throws {ToolError} the refusal */
export async function readListing(ctx, listingId) {
  await ctx.ensureChain();
  const listing = await inspectListing(ctx, listingId);
  if (listing.refusal) throw fail(listing.refusal, `Listing ${listingId}.`);
  return listing;
}

/** The bytes32 of the key the archive names. */
export function archiveDisclosureKeyHex(spec) {
  return `0x${Buffer.from(codeReview.parseDisclosureKey(spec.stake.disclosureKey)).toString('hex')}`;
}

/** The terms a hunter reads before paying, from the chain. */
export function termsForNotice(listing, priceWei) {
  const l = listing.onChain;
  return {
    listingId: listing.listingId,
    state: LISTING_STATES[Number(l.state)],
    maker: l.maker,
    repo: listing.spec.repo,
    baseCommit: listing.spec.baseCommit,
    bondWei: l.bondWei,
    priceWei,
    feeWei: priceWei - l.bondWei,
    awards: [...l.awards],
    lowestClass: OUTCOMES[Number(l.lowestClassCounted)],
    fixWindow: l.fixWindow,
    revealWindow: l.revealWindow,
    disputeWindow: l.disputeWindow,
    invited: l.allowlist.length > 0,
  };
}
