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
import { buildClaimArchive, checkClaimInputs, readClaimInputs } from './archive.js';
import { CLAIM_STATES, EXPIRIES } from './abi.js';
import { codeReview } from './common.js';
import { fail, ToolError } from './errors.js';
import { rawCid, isRawSha256Cid, isStorableCid, sha256Hex0x, gatewayGet } from './ipfs.js';
import { archiveDisclosureKeyHex, readListing, runnerFilesOf, termsForNotice } from './listing.js';
import { commitNotice } from './notices.js';
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

/** A Committed log of this hunter, listing and these two hashes, since the block the folder was prepared at. */
async function findCommitted(ctx, state) {
  const topics = ctx.topics('Committed', [null, BigInt(state.listingId), state.hunter]);
  const head = await ctx.rpc(() => ctx.provider.getBlockNumber());
  for (let from = state.startBlock; from <= head; from += ctx.logPageBlocks) {
    const to = Math.min(head, from + ctx.logPageBlocks - 1);
    const logs = await ctx.rpc(() => ctx.provider.getLogs({ address: ctx.contract, topics, fromBlock: from, toBlock: to }));
    for (const log of logs) {
      const parsed = ctx.parseLog(log);
      if (parsed?.name === 'Committed' && parsed.args.archiveHash === state.archiveSha256 && parsed.args.ciphertextSha256 === state.ciphertextSha256) {
        return { claimId: parsed.args.claimId, blockNumber: log.blockNumber };
      }
    }
  }
  return null;
}

async function prepare(ctx, ws, listing, inputs, hunter, listingId) {
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
  const next = { ...state, stage: 'committed', claimId: String(claimId), commitTx: state.commitTx ? { hash: state.commitTx.hash } : null };
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
    const found = await findCommitted(ctx, state);
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
  const log = receipt.logs.filter((l) => l.address.toLowerCase() === ctx.contract.toLowerCase()).map((l) => ctx.parseLog(l)).find((e) => e?.name === 'Committed');
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

/** The chain's rules for a commit now, and the wallet. @returns {Promise<bigint>} the live price */
async function commitPreflight(ctx, listingId, hunter) {
  const price = await ctx.read('commitPrice', [listingId]);
  if (!await ctx.read('acceptsCommits', [listingId])) throw fail('LISTING_NOT_ACCEPTING', `Listing ${listingId}.`);
  if (!await ctx.read('isAllowed', [listingId, hunter])) throw fail('NOT_ALLOWED');
  const fee = await ctx.feeCap();
  const balance = await ctx.rpc(() => ctx.provider.getBalance(hunter));
  if (balance < price + (COMMIT_GAS_ALLOWANCE + DISCLOSE_GAS_ALLOWANCE) * fee.maxFeePerGas) throw fail('INSUFFICIENT_FUNDS', 'Commit and disclose together need the price and their gas.');
  return price;
}

/** Signs and sends the commit: never twice, and only with everything on disk. */
async function sendCommit(ctx, ws, state, listingId) {
  const existing = await findCommitted(ctx, state);
  if (existing) return adoptLogged(ctx, ws, state, existing);

  readProvenFiles(ctx, ws, state);
  const price = await commitPreflight(ctx, listingId, state.hunter); // read just before signing: the live fee
  const data = ctx.encode('commit', [listingId, state.archiveSha256, state.ciphertextSha256]);
  let estimate;
  try {
    estimate = await ctx.estimate({ data, value: price });
  } catch (err) {
    if (err.code === 'CONTRACT_REFUSED') throw fail('LISTING_NOT_ACCEPTING', err.detail);
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
  return {
    stage: state.stage,
    claimId: BigInt(state.claimId),
    listingId: claim.listingId,
    archiveSha256: claim.archiveHash,
    ciphertextSha256: claim.ciphertextSha256,
    ciphertextCid: claim.ciphertextCid,
    valueWei: claim.bondWei + claim.prepayWei,
    bondWei: claim.bondWei,
    prepayWei: claim.prepayWei,
    discloseDeadline: times.discloseDeadline,
    revealableAt: times.revealableAt,
    commitTx: state.commitTx?.hash ?? null,
    discloseTx: state.discloseTx?.hash ?? null,
  };
}

/** The steps before a commit may be sent: the listing, the claim's files, the warning, the acknowledgement. */
async function readyToCommit(ctx, ws, state, listingId, hunter, acknowledge) {
  const listing = await readListing(ctx, listingId);
  const inputs = readClaimInputs(ws.claimDir);
  const { finding, warnings } = checkClaimInputs(inputs, listing.spec);
  if (state) {
    if (sha256Hex0x(buildClaimArchive(inputs)) !== state.archiveSha256) throw fail('INPUTS_CHANGED');
    if (archiveDisclosureKeyHex(listing.spec) !== state.disclosureKey) throw fail('ARCHIVE_MISMATCH');
  }
  const price = await commitPreflight(ctx, listingId, hunter);
  // Before any key is drawn, and on every run from which a commit may go out.
  ctx.notice(commitNotice(termsForNotice(listing, price)));
  const { baseline } = runnerFilesOf(listing.listingBytes, listing.spec);
  for (const w of [...warnings, ...lintObservable({ finding, pocPatch: inputs.pocPatch, baseline })]) ctx.notice(`${w.code}: ${w.detail}`);
  if (!acknowledge) throw fail('NEEDS_ACKNOWLEDGEMENT');
  return { listing, inputs };
}

/** commit, or a resume of one. See the top of this file. */
export async function runCommit(ctx, { claimDir, listingId, acknowledge = false, restart = false, acceptUnreadPin = false }) {
  const hunter = await ctx.hunterAddress();
  // The warning and the diligence text must reach someone: a library caller gives them somewhere to go.
  if (!ctx.onNotice) throw fail('USAGE', 'commit needs onNotice, for what must be said before anyone pays.');
  await ctx.ensureChain();
  const ws = openWorkspace(claimDir);
  return ws.withLock(async () => {
    let state = ws.loadState();
    if (state) checkBinding(state, { ...bindingOf(ctx, hunter), listingId: listingId ?? undefined });
    if (state && restart && state.stage !== 'prepared') throw fail('RESTART_REFUSED');
    if (state && restart) {
      ws.removePrepared();
      state = null;
    }
    if (!state && (listingId === undefined || listingId === null)) throw fail('USAGE', 'A first commit needs --listing <id>.');
    const id = BigInt(state ? state.listingId : listingId);

    if (state?.stage === 'commit-signed') state = await settleCommit(ctx, ws, state);
    if (!state || state.stage === 'prepared') {
      const { listing, inputs } = await readyToCommit(ctx, ws, state, id, hunter, acknowledge);
      if (!state) state = await prepare(ctx, ws, listing, inputs, hunter, id);
      state = await sendCommit(ctx, ws, state, id);
    }
    while (state.stage !== 'disclosed') state = await disclose(ctx, ws, state, { acceptUnreadPin });
    return resultOf(ctx, state);
  });
}
