// commit (design §14, erratum E5). Two steps on-chain with a pin between them, and a process can die between any
// two lines. The rules that make that harmless:
//
//   - Nothing is signed until the archive, keys and ciphertext are on disk at 0600, read back and proven against
//     each other by the arbiters' own verifyDisclosure.
//   - The signed commit is saved before it is broadcast, so a resume sends those bytes at that nonce. A second
//     signature needs the nonce proven used AND no Committed log of this hunter, listing and these hashes: the
//     contract takes the same hashes twice, for a second bond, so only this can stop that.
//   - The ciphertext is pinned only once the chain shows the claim, to the required depth. Pinning earlier would let a
//     maker read a pending commit's finding and front-run it (erratum E5).
//   - Every hash compared before an upload is the chain's, not this folder's.
//
// A late claim (node P43; design §13.2, decision D6) is this flow with what --late adds, and nothing else of it
// differs from a commit's: it sends lateClaim where a commit sends commit, with the same two hashes and commitPrice,
// on a listing the lens says takes late claims (acceptsLateClaims; no allowlist). A folder a late run prepared, or
// took over from a commit that was never signed, says so in its state (`late: true`) before anything is signed, and
// a run goes on with what the folder holds, whatever flag it has: --late takes over only a folder that has nothing
// signed when the run starts, and a signed commit stays a commit for the whole run. Three things are a late claim's alone:
//
//   - The price it signs is the price its terms named: a price that changed in between stops the run before it signs,
//     and before the wallet's balance is asked, so the new price is said even when the wallet cannot pay it.
//   - On a late claim's run a prepared folder's two hashes, a late claim's or those of a commit's folder the run is
//     about to take over, are looked for on the chain, as a commit's or a late claim's, before the listing is asked
//     and before --restart is weighed: a claim sent some other way has its bond, and is disclosed, --yes or not.
//   - --restart never starts a late claim over (owner, 2026-11-24): a changed late claim goes in a new folder.
//
// A commit asks, sends and says what it did before there was a late claim: test/late.test.js holds its calls, in order.
import { formatEther } from 'ethers';

import { buildClaimArchive, checkClaimInputs, readClaimInputs } from './archive.js';
import { CLAIM_STATES, EXPIRIES } from './abi.js';
import { codeReview } from './common.js';
import { fail, ToolError } from './errors.js';
import { rawCid, isRawSha256Cid, isStorableCid, sha256Hex0x, gatewayGet } from './ipfs.js';
import { archiveDisclosureKeyHex, lateTermsForNotice, readListing, runnerFilesOf, termsForNotice } from './listing.js';
import { COMMIT_HERE, commitNotice, lateClaimNotice } from './notices.js';
import { requirementWarnings } from './report.js';
import { lintObservable } from './observable.js';
import { openWorkspace } from './workspace.js';

/** What a commit may cost in gas, for the balance check: measured 259k, 125k. */
const COMMIT_GAS_ALLOWANCE = 400_000n;
const DISCLOSE_GAS_ALLOWANCE = 200_000n;

export const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** The three files, measured and proven against the saved hashes and each other. */
export function readProvenFiles(ctx, ws, state) {
  const archive = ws.read('archive.zip');
  const ciphertext = ws.read('ciphertext.age');
  const keysBytes = ws.read('keys.json');
  let keys;
  try {
    keys = JSON.parse(keysBytes.toString('utf8'));
  } catch {
    throw fail('FILE_CHANGED', 'keys.json');
  }
  if (typeof keys?.contentKey !== 'string' || typeof keys?.ephemeralKey !== 'string') throw fail('FILE_CHANGED', 'keys.json');
  ctx.secret(keys.contentKey);
  ctx.secret(keys.ephemeralKey);
  const proof = codeReview.verifyDisclosure({
    plaintext: u8(archive),
    ciphertext: u8(ciphertext),
    archiveSha256: state.archiveSha256,
    ciphertextSha256: state.ciphertextSha256,
    contentKey: keys.contentKey,
    ephemeralKey: keys.ephemeralKey,
    disclosureKey: hexToBytes(state.disclosureKey),
  });
  // The gate's code names what failed; its reason holds only hashes, but is not needed.
  if (!proof.ok) throw fail('FILE_CHANGED', proof.code);
  return { archive, ciphertext, keys };
}

/** Upload, then measure: the CID recomputed when it can be, the read-back always. `onUploaded` marks the point between. */
export async function pinVerified(ctx, bytes, sha256, { name, acceptUnread = false, deadlineText = '', onUploaded = null } = {}) {
  if (!ctx.pinner) throw fail('USAGE', 'This needs VERDIKTA_PIN_BACKEND.');
  if (sha256Hex0x(bytes) !== sha256) throw fail('FILE_CHANGED', name);
  let cid;
  try {
    cid = await ctx.pinner.pin(bytes, { name });
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw fail('PIN_FAILED');
  }
  if (!isStorableCid(cid)) throw fail('PIN_BAD_CID');
  if (isRawSha256Cid(cid) && cid !== rawCid(bytes)) throw fail('PIN_CID_MISMATCH', `${cid}.`);
  if (onUploaded) await onUploaded();
  await readBack(ctx, cid, bytes, sha256, { acceptUnread, deadlineText });
  return cid;
}

/** The CID's bytes through the gateway, hashed. Unavailable is retried; other bytes are refused at once. */
export async function readBack(ctx, cid, bytes, sha256, { acceptUnread = false, deadlineText = '' } = {}) {
  if (!ctx.gateway) throw fail('USAGE', 'This needs VERDIKTA_IPFS_GATEWAY.');
  const until = ctx.now() + ctx.readBackMs;
  for (;;) {
    let got = null;
    try {
      got = await gatewayGet(ctx.gateway, cid, { maxBytes: bytes.length + 1024, timeoutMs: Math.max(1000, Math.min(ctx.readBackMs, 60_000)), fetchImpl: ctx.fetch });
    } catch (err) {
      if (err?.why === 'too-large') throw fail('PIN_READBACK_MISMATCH', `${cid}.`);
    }
    if (got) {
      if (sha256Hex0x(got) !== sha256) throw fail('PIN_READBACK_MISMATCH', `${cid}.`);
      return true;
    }
    if (ctx.now() >= until) break;
    await ctx.sleep(ctx.pollMs ?? 5000);
  }
  // Only a CID computed here from these bytes can skip it: it names them, whatever the gateway says today.
  if (acceptUnread && isRawSha256Cid(cid) && cid === rawCid(bytes)) {
    ctx.notice(`The pinned bytes could not be read back through the gateway. ${cid} is the CID of the bytes hashed, so they are named correctly, but arbiters must be able to fetch them before the reveal.`);
    return false;
  }
  throw fail('PIN_NOT_READABLE', deadlineText);
}

function checkBinding(state, { chainId, contract, hunter, listingId }) {
  if (state.chainId !== String(chainId) || state.contract.toLowerCase() !== contract.toLowerCase() || state.hunter.toLowerCase() !== hunter.toLowerCase()) throw fail('STATE_MISMATCH');
  if (listingId !== undefined && listingId !== null && String(listingId) !== state.listingId) throw fail('STATE_MISMATCH', `This folder is for listing ${state.listingId}.`);
}

export const bindingOf = (ctx, hunter) => ({ chainId: ctx.chainId(), contract: ctx.contract, hunter });
export { checkBinding };

/** The event that says a commit made a claim; for a late claim's run, a late claim's too: the fields are the same. */
const COMMITTED = Object.freeze(['Committed']);
const EITHER_KIND = Object.freeze(['Committed', 'LateClaim']);
const eventsFor = (late) => (late ? EITHER_KIND : COMMITTED);

/** The state with its claim's kind: `late: true` on a late claim's, and no such key on a commit's, which stays as it was. */
function withKind(state, late) {
  if (late) return { ...state, late: true };
  const { late: _was, ...rest } = state;
  return rest;
}

/**
 * A Committed log of this hunter, listing and these two hashes, since the block the folder was prepared at. With
 * EITHER_KIND, which only a late claim's run passes, a LateClaim log too: one filter, both events in its first place.
 */
async function findCommitted(ctx, state, events = COMMITTED) {
  const topics = ctx.topics('Committed', [null, BigInt(state.listingId), state.hunter]);
  if (events.length > 1) topics[0] = events.map((name) => ctx.topics(name, [])[0]);
  const head = await ctx.rpc(() => ctx.provider.getBlockNumber());
  for (let from = state.startBlock; from <= head; from += ctx.logPageBlocks) {
    const to = Math.min(head, from + ctx.logPageBlocks - 1);
    const logs = await ctx.rpc(() => ctx.provider.getLogs({ address: ctx.contract, topics, fromBlock: from, toBlock: to }));
    for (const log of logs) {
      const parsed = ctx.parseLog(log);
      if (events.includes(parsed?.name) && parsed.args.archiveHash === state.archiveSha256 && parsed.args.ciphertextSha256 === state.ciphertextSha256) {
        return { claimId: parsed.args.claimId, blockNumber: log.blockNumber };
      }
    }
  }
  return null;
}

async function prepare(ctx, ws, listing, inputs, hunter, listingId, late = false) {
  const startBlock = await ctx.rpc(() => ctx.provider.getBlockNumber());
  ws.keepAside();
  const built = buildClaimArchive(inputs);
  ws.write('archive.zip', built);
  await ctx.step('prepare:archive');
  const archive = ws.read('archive.zip');
  if (!archive.equals(built)) throw fail('FILE_CHANGED', 'archive.zip');

  const keys = codeReview.generateDisclosureSecrets();
  ctx.secret(keys.contentKey);
  ctx.secret(keys.ephemeralKey);
  ws.write('keys.json', Buffer.from(`${JSON.stringify(keys, null, 2)}\n`));
  await ctx.step('prepare:keys');

  const disclosureKey = archiveDisclosureKeyHex(listing.spec);
  ws.write('ciphertext.age', Buffer.from(codeReview.encryptForDisclosure(u8(archive), listing.spec.stake.disclosureKey, keys)));
  await ctx.step('prepare:ciphertext');
  const ciphertext = ws.read('ciphertext.age');

  const state = {
    version: 1,
    stage: 'prepared',
    chainId: String(ctx.chainId()),
    contract: ctx.contract,
    hunter,
    listingId: String(listingId),
    archiveSha256: sha256Hex0x(archive),
    ciphertextSha256: sha256Hex0x(ciphertext),
    disclosureKey,
    startBlock,
    ...(late ? { late: true } : {}), // a late claim's folder says so from here on (node P43); a commit's has no such key
  };
  readProvenFiles(ctx, ws, state);
  ws.saveState(state);
  await ctx.step('prepare:saved');
  return state;
}

/** A commit that went out some other way counts once it is as deep as one of ours must be. */
async function adoptLogged(ctx, ws, state, found) {
  const until = ctx.now() + ctx.waitMs;
  for (;;) {
    const head = await ctx.rpc(() => ctx.provider.getBlockNumber());
    if (head - found.blockNumber + 1 >= ctx.confirmations) return adoptClaim(ctx, ws, state, found.claimId);
    if (ctx.now() >= until) throw fail('TX_PENDING', `Claim ${found.claimId} is not deep enough yet.`);
    await ctx.sleep(ctx.pollMs ?? 2000);
  }
}

async function adoptClaim(ctx, ws, state, claimId) {
  const claim = await ctx.readSettled('getClaim', [claimId]);
  const same = claim.hunter.toLowerCase() === state.hunter.toLowerCase() && String(claim.listingId) === state.listingId
    && claim.archiveHash === state.archiveSha256 && claim.ciphertextSha256 === state.ciphertextSha256;
  if (!same) throw fail('CLAIM_MISMATCH', `Claim ${claimId}.`);
  // the kind is the chain's from here on: for a commit that is the state as it was, with no `late` key
  const next = { ...withKind(state, claim.late === true), stage: 'committed', claimId: String(claimId), commitTx: state.commitTx ? { hash: state.commitTx.hash } : null };
  ws.saveState(next);
  await ctx.step('commit:saved');
  return next;
}

/** A saved commit's fate: the claim it made, or that it made none and its nonce is gone. */
async function settleCommit(ctx, ws, state) {
  // It may not have gone out yet: it pays the bond, and a claim without its keys loses it. So the same proof as
  // before the first send, on what is on disk now.
  const beforeResend = () => {
    readProvenFiles(ctx, ws, state);
    for (const name of ['archive.zip', 'keys.json', 'ciphertext.age']) ws.measure(name);
  };
  const outcome = await ctx.settleSaved(state.commitTx, { confirmations: ctx.confirmations, beforeResend });
  return finishCommitWait(ctx, ws, state, outcome);
}

async function finishCommitWait(ctx, ws, state, { receipt, gone }) {
  if (gone) {
    const found = await findCommitted(ctx, state, eventsFor(state.late === true));
    if (found) return adoptLogged(ctx, ws, state, found);
    const next = { ...state, stage: 'prepared', commitTx: null };
    ws.saveState(next);
    return next;
  }
  if (receipt.status !== 1) {
    const hash = state.commitTx.hash;
    const next = { ...state, stage: 'prepared', commitTx: null };
    ws.saveState(next);
    throw fail('COMMIT_REVERTED', `${await revertedReason(ctx, hash, state)} Transaction ${hash}.`);
  }
  await ctx.step('commit:mined');
  const log = receipt.logs.filter((l) => l.address.toLowerCase() === ctx.contract.toLowerCase()).map((l) => ctx.parseLog(l)).find((e) => eventsFor(state.late === true).includes(e?.name));
  if (!log) throw fail('CLAIM_MISMATCH', `Transaction ${state.commitTx.hash} made no claim.`);
  return adoptClaim(ctx, ws, state, log.args.claimId);
}

// The node's reason for a mined revert: replayed at its block. Only the contract's own strings are repeated.
// A commit's calldata holds two hashes and nothing else; a reveal's is never replayed like this.
async function revertedReason(ctx, hash, state) {
  try {
    const tx = await ctx.rpc(() => ctx.provider.getTransaction(hash));
    if (tx) await ctx.rpc(() => ctx.provider.call({ from: state.hunter, to: tx.to, data: tx.data, value: tx.value, blockTag: tx.blockNumber }));
    return '';
  } catch (err) {
    return err?.code === 'CONTRACT_REFUSED' ? `The contract says: ${err.detail}.` : '';
  }
}

/** A late claim's price is no longer the one its terms named: said with the price as it is now (node P43). */
const latePriceChanged = (now, quoted) => fail('LATE_PRICE_CHANGED', `It is ${formatEther(now)} ETH now, not ${formatEther(quoted)} ETH.`);

/**
 * Which refusal a commit gets on a listing that takes none: whether the listing takes late claims, and no more. A
 * lens that cannot say leaves the refusal a commit always had; an RPC that did not answer is said as that.
 */
async function takesLateClaimsOnly(ctx, listingId) {
  try {
    return await ctx.read('acceptsLateClaims', [listingId]);
  } catch (err) {
    if (err.code === 'CONTRACT_REFUSED') return false;
    throw err;
  }
}

/**
 * The chain's rules for a commit now, and the wallet. With `late` (node P43) a late claim's rules: a listing the lens
 * says takes late claims (acceptsLateClaims, ClaimLogic.commit's own rule) and no allowlist; the price is commitPrice's
 * for both. The wrong kind for the listing is refused here, before anything is drawn, pinned or signed, with a text
 * that names the other kind.
 * @param {bigint|null} [quoted] the price a late claim's terms named on this run, when it is about to be signed: a
 *   live price that is another is said here, before the wallet's balance is asked, and nothing is signed
 * @returns {Promise<bigint>} the live price
 */
async function commitPreflight(ctx, listingId, hunter, late = false, quoted = null) {
  const price = await ctx.read('commitPrice', [listingId]);
  if (late && quoted !== null && price !== quoted) throw latePriceChanged(price, quoted);
  if (late && !await ctx.read('acceptsLateClaims', [listingId])) throw fail(await ctx.read('acceptsCommits', [listingId]) ? 'LISTING_TAKES_COMMITS' : 'NO_LATE_CLAIMS', `Listing ${listingId}.`);
  if (!late && !await ctx.read('acceptsCommits', [listingId])) throw fail(await takesLateClaimsOnly(ctx, listingId) ? 'LATE_CLAIMS_ONLY' : 'LISTING_NOT_ACCEPTING', `Listing ${listingId}.`);
  if (!late && !await ctx.read('isAllowed', [listingId, hunter])) throw fail('NOT_ALLOWED');
  const fee = await ctx.feeCap();
  const balance = await ctx.rpc(() => ctx.provider.getBalance(hunter));
  if (balance < price + (COMMIT_GAS_ALLOWANCE + DISCLOSE_GAS_ALLOWANCE) * fee.maxFeePerGas) throw fail('INSUFFICIENT_FUNDS', 'Commit and disclose together need the price and their gas.');
  return price;
}

/**
 * Signs and sends the commit, or with `late` the late claim: never twice, and only with everything on disk.
 * @param {bigint|null} [quoted] the price a late claim's terms named on this run: it signs that price, or nothing
 */
async function sendCommit(ctx, ws, state, listingId, late = false, quoted = null) {
  const existing = await findCommitted(ctx, state, eventsFor(late));
  if (existing) return adoptLogged(ctx, ws, state, existing);

  readProvenFiles(ctx, ws, state);
  // A late claim signs the price its terms named, or nothing (node P43): commitPreflight holds the live price to
  // `quoted`. A commit signs the live price, as it always did.
  if (late && typeof quoted !== 'bigint') throw fail('INTERNAL', 'A late claim is signed only at a price its terms named.');
  const price = await commitPreflight(ctx, listingId, state.hunter, late, quoted); // read just before signing: the live fee
  const data = ctx.encode(late ? 'lateClaim' : 'commit', [listingId, state.archiveSha256, state.ciphertextSha256]);
  let estimate;
  try {
    estimate = await ctx.estimate({ data, value: price });
  } catch (err) {
    if (err.code === 'CONTRACT_REFUSED' && !late) throw fail('LISTING_NOT_ACCEPTING', err.detail);
    // lateClaim's own refusal is said as the late claim's; any other reason of the contract's is passed on as it is
    if (err.code === 'CONTRACT_REFUSED' && err.detail === 'not accepting late claims') throw fail('NO_LATE_CLAIMS', `Listing ${listingId}.`);
    // the fee rose after the price was read just above: the quoted value no longer covers it, and that is a changed price
    if (late && err.code === 'CONTRACT_REFUSED' && err.detail === 'payment below bond + fee') {
      const now = await ctx.read('commitPrice', [listingId]);
      if (now !== quoted) throw latePriceChanged(now, quoted);
    }
    throw err;
  }
  const rec = await ctx.sign({ data, value: price, gasLimit: (estimate * 5n) / 4n + 10000n });
  // The files are private and on disk, and these bytes are saved, before any of it can leave.
  const next = { ...state, stage: 'commit-signed', commitTx: rec };
  ws.saveState(next);
  await ctx.step('commit:signed');
  for (const name of ['archive.zip', 'keys.json', 'ciphertext.age', 'state.json']) ws.measure(name);
  await ctx.broadcast(rec);
  await ctx.step('commit:sent');
  return finishCommitWait(ctx, ws, next, await ctx.waitMined(rec, { confirmations: ctx.confirmations }));
}

async function disclose(ctx, ws, state, { acceptUnreadPin }) {
  const claim = await ctx.readSettled('getClaim', [state.claimId]);
  const sameClaim = claim.hunter.toLowerCase() === state.hunter.toLowerCase() && claim.archiveHash === state.archiveSha256 && claim.ciphertextSha256 === state.ciphertextSha256;
  if (!sameClaim) throw fail('CLAIM_MISMATCH', `Claim ${state.claimId}.`);
  if (claim.disclosedAt !== 0n) {
    const next = { ...state, stage: 'disclosed', ciphertextCid: claim.ciphertextCid, discloseTx: state.discloseTx ? { hash: state.discloseTx.hash } : null };
    ws.saveState(next);
    return next;
  }
  const stored = CLAIM_STATES[Number(claim.state)];
  if (stored === 'Expired') throw fail('CLAIM_ENDED', `Expired: ${EXPIRIES[Number(claim.expiry)]}.`);

  // A disclose already sent decides first: it is the same call, at its nonce.
  let current = state;
  if (current.discloseTx?.raw) {
    const done = await settleDisclose(ctx, ws, current);
    if (done.stage === 'disclosed') return done;
    current = done;
  }

  const [times, now] = await Promise.all([ctx.read('claimTimes', [state.claimId]), ctx.chainTime()]);
  const deadline = times.discloseDeadline;
  if (now >= deadline) throw fail('DISCLOSE_WINDOW_OVER', `It ended at ${deadline} on the chain's clock.`);

  // Everything uploaded was read just now and compared with the chain's hash, not this folder's.
  const { ciphertext } = readProvenFiles(ctx, ws, current);
  if (sha256Hex0x(ciphertext) !== claim.ciphertextSha256) throw fail('FILE_CHANGED', 'ciphertext.age');
  const deadlineText = `Disclose before ${deadline} on the chain's clock, or the bond goes to the maker.`;
  let cid = current.ciphertextCid ?? null;
  if (cid) {
    try {
      await readBack(ctx, cid, ciphertext, claim.ciphertextSha256, { acceptUnread: acceptUnreadPin, deadlineText });
    } catch (err) {
      if (err.code !== 'PIN_NOT_READABLE') throw err;
      cid = null;
    }
  }
  if (!cid) {
    cid = await pinVerified(ctx, ciphertext, claim.ciphertextSha256, { name: 'ciphertext.age', acceptUnread: acceptUnreadPin, deadlineText, onUploaded: () => ctx.step('disclose:pinned') });
    await ctx.step('disclose:read-back');
    current = { ...current, stage: 'pinned', ciphertextCid: cid };
    ws.saveState(current);
    await ctx.step('disclose:cid-saved');
  }

  const data = ctx.encode('disclose', [state.claimId, cid]);
  const estimate = await ctx.estimate({ data }).catch((err) => {
    if (err.code === 'CONTRACT_REFUSED' && /disclose window over/.test(err.message)) throw fail('DISCLOSE_WINDOW_OVER');
    throw err;
  });
  const rec = await ctx.sign({ data, gasLimit: (estimate * 5n) / 4n + 10000n });
  current = { ...current, stage: 'disclose-signed', discloseTx: rec };
  ws.saveState(current);
  await ctx.step('disclose:signed');
  await ctx.broadcast(rec);
  await ctx.step('disclose:sent');
  return finishDiscloseWait(ctx, ws, current, await ctx.waitMined(rec));
}

async function settleDisclose(ctx, ws, state) {
  return finishDiscloseWait(ctx, ws, state, await ctx.settleSaved(state.discloseTx));
}

async function finishDiscloseWait(ctx, ws, state, { receipt, gone }) {
  if (receipt && receipt.status === 1) await ctx.step('disclose:mined');
  const claim = await ctx.readSettled('getClaim', [state.claimId]);
  if (claim.disclosedAt !== 0n) {
    const next = { ...state, stage: 'disclosed', ciphertextCid: claim.ciphertextCid, discloseTx: state.discloseTx ? { hash: state.discloseTx.hash } : null };
    ws.saveState(next);
    await ctx.step('disclose:saved');
    return next;
  }
  const hash = state.discloseTx?.hash;
  const next = { ...state, stage: state.ciphertextCid ? 'pinned' : 'committed', discloseTx: null };
  ws.saveState(next);
  if (gone) return next;
  throw fail('DISCLOSE_REVERTED', `Transaction ${hash}.`);
}

async function resultOf(ctx, state) {
  const claim = await ctx.readSettled('getClaim', [state.claimId]);
  const times = await ctx.read('claimTimes', [state.claimId]);
  // node P32: the reveal deadline as the lens has it, or, while an earlier claim heads the queue, the earliest it can be
  // (revealWindow from the fix window's end; later if that claim is still open then). Only while it is still to come:
  // a re-run on a claim that has revealed, or ended, says none.
  const { revealWindow, headClaim } = await ctx.read('getListing', [claim.listingId]);
  const lens = CLAIM_STATES[Number(await ctx.read('claimState', [state.claimId]))];
  const ahead = lens === 'Committed' || lens === 'Revealable';
  const earliest = ahead ? times.revealDeadline === 0n : null;
  return {
    stage: state.stage,
    claimId: BigInt(state.claimId),
    listingId: claim.listingId,
    ...(claim.late ? { late: true } : {}), // a late claim says so (node P43), by the chain's word; a commit's result is as it was
    archiveSha256: claim.archiveHash,
    ciphertextSha256: claim.ciphertextSha256,
    ciphertextCid: claim.ciphertextCid,
    valueWei: claim.bondWei + claim.prepayWei,
    bondWei: claim.bondWei,
    prepayWei: claim.prepayWei,
    discloseDeadline: times.discloseDeadline,
    revealableAt: times.revealableAt,
    revealDeadline: !ahead ? null : earliest ? times.revealableAt + BigInt(revealWindow) : times.revealDeadline,
    revealDeadlineEarliest: earliest,
    // the earliest open claim on the listing while it is another: this one reveals after it (commit order)
    waitsFor: earliest && headClaim !== 0n && headClaim !== BigInt(state.claimId) ? headClaim : null,
    commitTx: state.commitTx?.hash ?? null,
    discloseTx: state.discloseTx?.hash ?? null,
  };
}

/**
 * A prepared late claim's files, held to the archive the folder was prepared from before anything else is said of
 * them (node P43). Changed, spoiled, missing, over the size this tool reads or no file at all: each is said as a
 * changed file, since the texts that say to fix a file in place or to pass --restart are no way on for a late claim.
 * A file that could not be read is said as that.
 */
function preparedLateInputs(claimDir, state) {
  let inputs;
  try {
    inputs = readClaimInputs(claimDir);
  } catch (err) {
    if (err.code !== 'ARCHIVE_TOO_LARGE') throw err;
    throw fail('LATE_INPUTS_CHANGED');
  }
  if (!inputs.finding || !inputs.report || !inputs.pocPatch) throw fail('LATE_INPUTS_CHANGED');
  let archive = null;
  try {
    archive = buildClaimArchive(inputs);
  } catch { /* over the size as a whole: no archive, so not the one prepared */ }
  if (archive === null || sha256Hex0x(archive) !== state.archiveSha256) throw fail('LATE_INPUTS_CHANGED');
  return inputs;
}

/**
 * The steps before a commit, or with `late` a late claim, may be sent: the listing, the claim's files, the warning,
 * the acknowledgement. A late claim's listing comes back with `quotedWei`, the price its terms named.
 */
async function readyToCommit(ctx, ws, state, listingId, hunter, acknowledge, late = false) {
  const listing = await readListing(ctx, listingId);
  // a prepared late claim's files are held to its archive first (preparedLateInputs); a commit's are read as they were
  const inputs = late && state ? preparedLateInputs(ws.claimDir, state) : readClaimInputs(ws.claimDir);
  const { finding, warnings } = checkClaimInputs(inputs, listing.spec);
  if (state) {
    if (sha256Hex0x(buildClaimArchive(inputs)) !== state.archiveSha256) throw fail('INPUTS_CHANGED');
    if (archiveDisclosureKeyHex(listing.spec) !== state.disclosureKey) throw fail('ARCHIVE_MISMATCH');
  }
  const price = await commitPreflight(ctx, listingId, hunter, late);
  // Before any key is drawn, and on every run from which a commit may go out.
  if (late) ctx.notice(lateClaimNotice(lateTermsForNotice(listing, price)));
  else ctx.notice(commitNotice(termsForNotice(listing, price)));
  const { baseline } = runnerFilesOf(listing.listingBytes, listing.spec);
  // report.md's requirement section is advice (owner, 2026-11-10, Q73 #2): said again here, never a refusal
  for (const w of [...warnings, ...lintObservable({ finding, pocPatch: inputs.pocPatch, baseline }), ...requirementWarnings(inputs.report)]) ctx.notice(`${w.code}: ${w.detail}`);
  if (!acknowledge) throw fail('NEEDS_ACKNOWLEDGEMENT');
  return { listing: late ? { ...listing, quotedWei: price } : listing, inputs };
}

/** commit, or a resume of one; with `late` (--late, node P43) a late claim. See the top of this file. */
export async function runCommit(ctx, { claimDir, listingId, late: lateFlag = false, acknowledge = false, restart = false, acceptUnreadPin = false }) {
  const hunter = await ctx.hunterAddress();
  // The warning and the diligence text must reach someone: a library caller gives them somewhere to go.
  if (!ctx.onNotice) throw fail('USAGE', 'commit needs onNotice, for what must be said before anyone pays.');
  await ctx.ensureChain();
  const ws = openWorkspace(claimDir);
  return ws.withLock(async () => {
    let state = ws.loadState();
    if (state) checkBinding(state, { ...bindingOf(ctx, hunter), listingId: listingId ?? undefined });
    // The run's kind. A folder with something signed, or with a claim, keeps its own for the whole run, whatever
    // the flag says and even if its signed transaction turns out to be gone: --late takes over only a folder that
    // has nothing signed when the run starts. A folder a late run prepared or took over is a late claim's without it.
    const unsigned = !state || state.stage === 'prepared';
    const late = unsigned ? lateFlag === true || state?.late === true : state.late === true;
    if (lateFlag === true && !late) ctx.notice(COMMIT_HERE);
    // On a late claim's run a prepared folder's two hashes may have a claim on the chain already, sent some other
    // way. That is asked first: before the listing or the wallet's balance can refuse the run, before --yes, and
    // before --restart is weighed.
    if (late && state?.stage === 'prepared') {
      const existing = await findCommitted(ctx, state, EITHER_KIND);
      if (existing) state = await adoptLogged(ctx, ws, state, existing);
    }
    // --restart starts a commit over, never a late claim, signed or not: refused before anything is removed. A late
    // run that has just found the folder's hashes on the chain as an ordinary commit holds a commit, and gets a
    // commit's refusal on the next line.
    const holdsClaim = Boolean(state) && state.stage !== 'prepared';
    if (late && restart && !(holdsClaim && state.late !== true)) throw fail('LATE_NEEDS_NEW_FOLDER', holdsClaim ? 'This folder\'s late claim is signed or on the chain: run commit again without --restart to go on with that one.' : undefined);
    if (state && restart && state.stage !== 'prepared') throw fail('RESTART_REFUSED');
    if (state && restart) {
      ws.removePrepared();
      state = null;
    }
    if (!state && (listingId === undefined || listingId === null)) throw fail('USAGE', 'A first commit needs --listing <id>.');
    const id = BigInt(state ? state.listingId : listingId);

    if (state?.stage === 'commit-signed') state = await settleCommit(ctx, ws, state);
    if (!state || state.stage === 'prepared') {
      const { listing, inputs } = await readyToCommit(ctx, ws, state, id, hunter, acknowledge, late);
      if (!state) state = await prepare(ctx, ws, listing, inputs, hunter, id, late);
      // a commit's prepared folder that a late run takes over is a late claim's from here on, as one it prepared is
      else if (late && state.late !== true) ws.saveState(state = withKind(state, true));
      state = await sendCommit(ctx, ws, state, id, late, listing.quotedWei);
    }
    // a late run that found the folder's hashes on the chain as an ordinary commit goes on with that commit, and says so
    if (late && lateFlag === true && state.late !== true) ctx.notice(COMMIT_HERE);
    while (state.stage !== 'disclosed') state = await disclose(ctx, ws, state, { acceptUnreadPin });
    const result = await resultOf(ctx, state);
    // What this run says of the reveal, recorded (node P32): status compares the chain's deadline with it, and says
    // when a release or a roll-forward moved it earlier than the hunter was told.
    const told = result.revealDeadline === null ? null : { revealableAt: String(result.revealableAt), revealDeadline: String(result.revealDeadline), earliest: result.revealDeadlineEarliest };
    if (told && JSON.stringify(state.told) !== JSON.stringify(told)) ws.saveState({ ...state, told });
    return result;
  });
}
