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
// A late claim (node P43; design §13.2, decision D6) is the same flow with one call changed: `late` sends lateClaim
// where a commit sends commit, with the same two hashes and the same price, on a listing that takes late claims and
// no commit. The flag is read only until something is signed: a signed transaction is saved with its kind, a resume
// sends those bytes whatever flag it has, and a claim that exists is the kind the chain says. Both events are looked
// for before a signature, a commit's and a late claim's, so neither kind is ever paid for twice.
//
// A claim with the folder's two hashes that is already on the chain, sent some other way, is adopted before anything
// else is asked of a prepared folder: before the listing, the wallet's balance or --restart can refuse the run or
// remove the keys that claim needs. Its depth is measured once its log is read, against a head read after it, and
// the log's block is then held to its hash, so one a reorganization moved is looked for again and never pinned early.
//
// A late claim is signed only when no claim of its hashes can be on the chain unseen (nonceAndClaimAt): the wallet's
// nonce and the logs are read at one block, held to its hash, and the pending count after them. A transaction of
// this wallet mined by that block is in the logs read, so a claim it made is found. One mined or sent later raises
// the pending count above that nonce, and nothing is signed (WALLET_BUSY). And the late claim is signed at that nonce,
// so a transaction that takes it afterwards leaves the signature unusable: it is found gone, and the claim adopted.
// --restart asks the same, whatever the flag, since a prepared folder names no kind; and where it starts a commit
// over it sets the prepared files aside rather than deleting them, for the one case no read can see: a claim someone
// holds and has not sent yet.
//
// The anchor, and what it proves. The logs are read from the block the folder was prepared at (startBlock), and that
// bound holds only while that block is still on the chain: a reorganization that rolled the chain back under it can
// mine a claim of the folder's hashes, sent some other way since, in a block below it. So preparation saves an anchor
// before any key is drawn, in a file of its own beside state.json, which stays what it was: the head (its number is
// startBlock) and the node's finalized block, each by number and hash. The folder's two hashes do not exist before
// its keys are drawn. So:
//
//   - while the block at startBlock still has the saved hash, every claim of those hashes is in a later block, and
//     the scan from startBlock is complete;
//   - when it has another hash, or the chain is shorter, the saved finalized block is held to its hash: a finalized
//     block is not reorganized, so a scan from it to the head is complete whatever happened above it, and a claim
//     found there is adopted from its log, as any is;
//   - when neither can be shown (no anchor, one of another block, no finalized block saved, one that is gone, or a
//     scan that cannot be read through), the logs prove nothing: a late claim is not signed, and --restart with
//     --late sets nothing aside (START_UNPROVEN). Its text ends with what to do, which differs with the reason:
//     through a node that gives the logs the same folder can show it, and only where the folder itself cannot is a
//     new folder the way on, after a look for a claim of the old hashes, which a new one would pay for again.
//
// This is asked where a late claim is about to be paid for: inside the reads of nonceAndClaimAt before one is signed,
// on any run with --late of a prepared folder before its terms, and before saved late-claim bytes are sent again
// (settleCommit: a reorganization since they were signed can have mined these hashes in another transaction, of a
// lower nonce, and left theirs free; the bytes are then kept, unsent, until that claim is adopted at its depth, since
// their nonce was not shown to be used). And wherever a folder's claim is looked for, the logs are read from the bound
// the anchor proves, whatever the flag and the kind: on a resume of a prepared folder, and when a saved
// transaction's nonce is gone. A commit is signed as it always was, and no run without --late is refused for its
// anchor.
//
// --restart starts a commit over only once the new one may go out: after the listing, the wallet and --yes have had
// their say (readyToCommit). A refusal before that leaves the prepared folder whole, with its keys. Those reads take
// their time, so the old files' claim is looked for once more, the last thing before they are set aside.
//
// And --restart does not start a late claim over, nor is a late claim ever signed in a folder that has set a claim's
// files aside (LATE_NEEDS_NEW_FOLDER, lateNeedsNewFolder): such a folder knows nothing of the earlier files, so no
// read it makes before it pays can find their claim. A new folder files the late claim, and the old one stays whole.
//
// For the same reason a folder that set files aside signs nothing more once its new commit lost its nonce to another
// transaction of the wallet (COMMIT_REPLACED, finishCommitWait): that transaction may be a claim of the files set
// aside. The refusal is not recorded: the signed bytes stay saved, and every run reads it again from the chain and
// the disk, so no stop on the way leaves a folder that signs. The commit goes in a new folder.
import { buildClaimArchive, checkClaimInputs, readClaimInputs } from './archive.js';
import { CLAIM_STATES, EXPIRIES } from './abi.js';
import { codeReview } from './common.js';
import { fail, ToolError } from './errors.js';
import { rawCid, isRawSha256Cid, isStorableCid, sha256Hex0x, gatewayGet } from './ipfs.js';
import { archiveDisclosureKeyHex, readListing, runnerFilesOf, termsForNotice } from './listing.js';
import { commitNotice, kindNotice, priceMovedNotice } from './notices.js';
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

/** The two events that say a claim was made: a commit's and a late claim's, with the same fields (StakeAttestation.sol). */
const CLAIM_MADE = Object.freeze(['Committed', 'LateClaim']);

// Where the order of reads decides whether a bond is paid twice, or a ciphertext pinned early, each read has to be
// the node's answer at that moment. A provider may answer its own methods from a short memory (ethers keeps an answer
// for 250 ms unless told not to, and a library caller's provider may), so the reads below go to the node by
// provider.send: the head, a block's hash, the wallet's transaction count, the logs.
const quantity = (n) => `0x${n.toString(16)}`;

/** The head's number, asked of the node. */
async function headNow(ctx) {
  return Number(BigInt(await ctx.rpc(() => ctx.provider.send('eth_blockNumber', []))));
}

/** The wallet's transaction count at a block number or a tag ('pending'), asked of the node. */
async function countAt(ctx, address, at) {
  return Number(BigInt(await ctx.rpc(() => ctx.provider.send('eth_getTransactionCount', [address, typeof at === 'number' ? quantity(at) : at]))));
}

const isBlockId = (b) => Number.isSafeInteger(b?.number) && b.number >= 0 && typeof b.hash === 'string' && /^0x[0-9a-f]{64}$/.test(b.hash);

/**
 * A block's number and hash, asked of the node: the latest, the one at a number, or the one a tag names. Null when
 * there is none, and when the answer is not a block with a number and a hash: every caller takes null as no proof.
 */
async function blockIdAt(ctx, at = 'latest') {
  const block = await ctx.rpc(() => ctx.provider.send('eth_getBlockByNumber', [typeof at === 'number' ? quantity(at) : at, false]));
  let id = null;
  try {
    id = { number: Number(BigInt(block.number)), hash: String(block.hash).toLowerCase() };
  } catch {
    return null;
  }
  return isBlockId(id) ? id : null;
}

/** The folder's anchor: the block it was prepared at and the node's finalized block then (see the top of this file). */
const ANCHOR_FILE = 'anchor.json';

/**
 * The node's finalized block, or null: a node that names none (it refuses the tag, or answers nothing), or one that
 * names a block above the head it has just given, which is no bound.
 */
async function finalizedBlockOf(ctx, head) {
  try {
    const block = await blockIdAt(ctx, 'finalized');
    return block && block.number <= head.number ? block : null;
  } catch (err) {
    if (err.code === 'RPC_UNAVAILABLE' || err.code === 'CONTRACT_REFUSED') return null;
    throw err;
  }
}

/** The anchor as it was saved, or null: none, or one that cannot be read as an anchor. */
function readAnchor(ws) {
  const bytes = ws.readOptional(ANCHOR_FILE);
  if (bytes === null) return null;
  let anchor;
  try {
    anchor = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (anchor?.version !== 1 || !isBlockId(anchor.head) || (anchor.finalized !== null && !isBlockId(anchor.finalized))) return null;
  // a finalized block above the head it was read under is no bound: preparation saves none, so this is not its file
  if (anchor.finalized && anchor.finalized.number > anchor.head.number) return null;
  return anchor;
}

// What a hunter does about a bound that cannot be shown differs with the reason (START_UNPROVEN's text ends with one
// of these). Where the folder itself cannot show it, the way on is a new folder, which is new hashes: a claim of the
// old ones that was sent some other way would then be paid for a second time, and that is said first.
const NEW_FOLDER = 'If you sent this folder\'s two hashes some other way (state.json has them), find that claim among this wallet\'s transactions first: it needs this folder\'s keys, and a claim from a new folder would pay a second bond. If you did not, prepare the claim in a new folder: copy finding.json, report.md and the patches there, and run commit --late on it.';
// Where only a node's answer is missing, the folder can still show it through a node that gives the answer, and a
// new folder is the one thing not to do: the claim may be in the logs that were not read.
const otherRpc = (from) => `Run the same command again through an RPC that serves the logs from block ${from}: the scan is then complete, and a claim found there is adopted. A new folder is not the way on here: a claim of these hashes may be in the logs that were not read.`;

/**
 * The block from which the logs hold every claim of the folder's hashes, as its anchor proves it now: `from`, with
 * `reorganized` when that is the saved finalized block. Or `unproven`: the reason nothing shows it and what to do
 * then, in words for the hunter.
 */
async function provenStart(ctx, ws, state) {
  const anchor = readAnchor(ws);
  if (!anchor) return { unproven: `It has no anchor: an earlier version of this tool prepared it, or the file is gone. ${NEW_FOLDER}` };
  if (anchor.head.number !== state.startBlock) return { unproven: `Its anchor is of another block than the one it was prepared at. ${NEW_FOLDER}` };
  if ((await blockIdAt(ctx, state.startBlock))?.hash === anchor.head.hash) return { from: state.startBlock };
  // another block at that height, or none: the chain was rolled back under the folder
  if (!anchor.finalized) return { unproven: `The chain was reorganized below the block it was prepared at, and the node named no finalized block when it was prepared. ${NEW_FOLDER}` };
  if ((await blockIdAt(ctx, anchor.finalized.number))?.hash !== anchor.finalized.hash) return { unproven: `The chain was reorganized below the block it was prepared at, and below the finalized block saved with it. ${NEW_FOLDER}` };
  return { from: anchor.finalized.number, reorganized: true };
}

/**
 * The claim of the folder's hashes in the logs up to `upTo`, read from where the anchor proves them complete
 * (provenStart). Where it proves nothing, or the longer scan from the finalized block cannot be read through, the
 * logs are read from startBlock as they always were: a claim found is a claim all the same, and with none found
 * `unproven` says why that is no proof. `from` is where the scan that answered started.
 */
async function anchoredClaim(ctx, ws, state, upTo = null) {
  const start = await provenStart(ctx, ws, state);
  if (start.reorganized) {
    try {
      return { existing: await findCommitted(ctx, state, upTo, start.from), from: start.from, unproven: null };
    } catch (err) {
      if (err.code !== 'RPC_UNAVAILABLE') throw err;
      start.unproven = `The chain was reorganized below the block it was prepared at, and the node did not give all the logs since the finalized block saved with it. ${otherRpc(start.from)}`;
    }
  }
  const existing = await findCommitted(ctx, state, upTo);
  return { existing, from: state.startBlock, unproven: existing ? null : withSetAside(ws, start.unproven ?? null) };
}

/**
 * A Committed or a LateClaim log of this hunter, listing and these two hashes, since the block the folder was prepared
 * at. Either kind is a claim on these hashes that has its bond: one filter, the two events' topics in its first place.
 *
 * The range is read in pages of ctx.logPageBlocks. An RPC that caps eth_getLogs below that refuses a page, so a page
 * that is refused is asked for again in halves, down to one block, as settlement.js reads its own: a prepared folder
 * is scanned before a resume and before --restart, and on such an RPC neither could go on once the folder was older
 * than the cap. A node that does not answer at all refuses the single block too, and that is the error.
 */
async function findCommitted(ctx, state, upTo = null, start = state.startBlock) {
  const [first, ...indexed] = ctx.topics('Committed', [null, BigInt(state.listingId), state.hunter]);
  const topics = [[first, ctx.topics('LateClaim', [])[0]], ...indexed];
  // up to the head as it is now, or up to the block a caller has read something else at (nonceAndClaimAt); from the
  // block the folder was prepared at, or from the lower one its anchor proves (anchoredClaim)
  const head = upTo ?? await headNow(ctx);
  let page = Math.max(1, Math.floor(ctx.logPageBlocks));
  for (let from = start; from <= head;) {
    const to = Math.min(head, from + page - 1);
    let logs;
    try {
      logs = await ctx.rpc(() => ctx.provider.send('eth_getLogs', [{ address: ctx.contract, topics, fromBlock: quantity(from), toBlock: quantity(to) }]));
    } catch (err) {
      // a refusal, not a read that timed out (that one says so): waiting again on every half would only take longer
      if (err.code !== 'RPC_UNAVAILABLE' || err.detail || to === from) throw err;
      page = Math.ceil((to - from + 1) / 2);
      continue;
    }
    from = to + 1;
    for (const log of logs) {
      const parsed = ctx.parseLog(log);
      if (CLAIM_MADE.includes(parsed?.name) && parsed.args.archiveHash === state.archiveSha256 && parsed.args.ciphertextSha256 === state.ciphertextSha256) {
        return { claimId: parsed.args.claimId, blockNumber: Number(BigInt(log.blockNumber)), blockHash: String(log.blockHash).toLowerCase(), txHash: log.transactionHash };
      }
    }
  }
  return null;
}

/**
 * Whether a claim of the folder's two hashes may be on the chain, or on its way there, unseen. The reads, in this
 * order: the head, by its number and its hash; the wallet's nonce at that block; the logs up to that same block; the
 * wallet's pending count, after them; and that block again, which must still have that hash.
 *
 *   - `existing`: the claim, when the logs hold one.
 *   - `nonce`: the wallet's next nonce as mined at that block. With no claim in the logs, no transaction below it
 *     made one: they are all in the blocks read.
 *   - `pending` above `nonce`: a transaction of this wallet is not mined yet, or was mined after that block, and it
 *     may be the claim. The caller holds back (WALLET_BUSY): a run again finds it once it is mined.
 *
 * The block is read again because a height is not a block: a reorganization between the nonce and the logs would
 * have them read on different forks, the nonce counting a claim the logs no longer hold. Then nothing here can be
 * relied on, and the run ends before anything is signed or set aside (RPC_UNAVAILABLE: run again).
 *
 * A transaction sent after the last read is not seen by any read. A caller that signs at `nonce` shuts it out all the
 * same: only one transaction can be mined at a nonce. What is left is a reorganization after the last read that takes
 * a mined transaction of this wallet out, so that these hashes can be mined at its lower nonce: nothing read before it
 * can show that, and a resume reads all of this again before saved bytes are sent (settleCommit).
 */
async function nonceAndClaimAt(ctx, ws, state) {
  const head = await blockIdAt(ctx);
  if (!head) throw fail('RPC_UNAVAILABLE');
  const nonce = await countAt(ctx, state.hunter, head.number);
  // the logs, from where the folder's anchor proves them complete; `unproven` when it proves nothing
  const { existing, from, unproven } = await anchoredClaim(ctx, ws, state, head.number);
  const pending = existing ? nonce : await countAt(ctx, state.hunter, 'pending');
  if ((await blockIdAt(ctx, head.number))?.hash !== head.hash) throw fail('RPC_UNAVAILABLE', 'The chain was reorganized while it was read, so nothing was signed.');
  return { existing, from, unproven, nonce, pending };
}

/** The state with its kind: `late: true` on a late claim's, and no such key on a commit's, which stays as it was. */
function withKind(state, late) {
  const { late: _was, ...rest } = state;
  return late ? { ...rest, late: true } : rest;
}

async function prepare(ctx, ws, listing, inputs, hunter, listingId) {
  // The anchor, read and saved before any key is drawn: the head, whose number is startBlock, and the node's
  // finalized block. No claim of this folder's hashes can be in either, or in any block that was there by now.
  const head = await blockIdAt(ctx);
  if (!head) throw fail('RPC_UNAVAILABLE');
  const finalized = await finalizedBlockOf(ctx, head);
  const startBlock = head.number;
  ws.keepAside();
  ws.write(ANCHOR_FILE, Buffer.from(`${JSON.stringify({ version: 1, head, finalized }, null, 2)}\n`));
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

/**
 * A commit that went out some other way counts once it is as deep as one of ours must be. A reorganization can move
 * its transaction to another block, or take it out, after its log was read, so a log is never taken at its word for
 * longer than one look: the head is read after the log, as waitMined reads it after a receipt, and the log's block is
 * then held to the hash the log gave. A claim that is not where its log said is looked for again, and adopted with
 * the id, the block and the transaction it has then; one that is gone is waited for, up to the limit.
 */
async function adoptLogged(ctx, ws, state, found, start = state.startBlock) {
  const until = ctx.now() + ctx.waitMs;
  let seen = found;
  for (;;) {
    if (seen) {
      const head = await headNow(ctx);
      if (head - seen.blockNumber + 1 >= ctx.confirmations) {
        const block = await blockIdAt(ctx, seen.blockNumber);
        if (block?.hash === seen.blockHash) return adoptClaim(ctx, ws, state, seen.claimId, seen.txHash);
      }
    }
    if (ctx.now() >= until) throw fail('TX_PENDING', `Claim ${(seen ?? found).claimId} is not deep enough yet.`);
    await ctx.sleep(ctx.pollMs ?? 2000);
    seen = await findCommitted(ctx, state, null, start);
  }
}

/**
 * @param {string|null} [txHash] the transaction that made the claim: the saved one's, or, for a claim found by its log,
 *   that log's, which is another transaction when the claim went out some other way
 */
async function adoptClaim(ctx, ws, state, claimId, txHash = state.commitTx?.hash ?? null) {
  const claim = await ctx.readSettled('getClaim', [claimId]);
  const same = claim.hunter.toLowerCase() === state.hunter.toLowerCase() && String(claim.listingId) === state.listingId
    && claim.archiveHash === state.archiveSha256 && claim.ciphertextSha256 === state.ciphertextSha256;
  if (!same) throw fail('CLAIM_MISMATCH', `Claim ${claimId}.`);
  // the kind is the chain's from here on: a claim that went out another way is adopted as what it is
  const next = { ...withKind(state, claim.late === true), stage: 'committed', claimId: String(claimId), commitTx: txHash ? { hash: txHash } : null };
  ws.saveState(next);
  await ctx.step('commit:saved');
  return next;
}

/** A saved commit's fate: the claim it made, or that it made none and its nonce is gone. */
async function settleCommit(ctx, ws, state) {
  // It may not have gone out yet: it pays the bond, and a claim without its keys loses it. So the same proof as
  // before the first send, on what is on disk now.
  const beforeResend = async () => {
    readProvenFiles(ctx, ws, state);
    for (const name of ['archive.zip', 'keys.json', 'ciphertext.age']) ws.measure(name);
    if (state.late !== true) return undefined;
    // A late claim's bytes were signed on a proof (sendCommit), and they go out again only on the same one, read now:
    // a reorganization since can have left their nonce free and mined these hashes, sent some other way, in a
    // transaction of a lower nonce, or left a lower nonce unused for one to take.
    const at = await nonceAndClaimAt(ctx, ws, state);
    // the claim is made, so these bytes are not sent: its log is handed on, to be adopted once it holds
    if (at.existing) return { existing: at.existing, from: at.from };
    const kept = `The late claim this folder signed earlier (transaction ${state.commitTx.hash}) was not sent again`;
    if (at.unproven) throw fail('START_UNPROVEN', `${at.unproven} ${kept}: if an earlier run sent it, it can still be mined, so look for it before a new folder pays for another.`);
    if (at.nonce < state.commitTx.nonce) throw fail('WALLET_BUSY', `${kept}: a transaction of this wallet before it is not mined, and that one may be this same claim, sent some other way.`);
    return undefined;
  };
  const outcome = await ctx.settleSaved(state.commitTx, { confirmations: ctx.confirmations, beforeResend });
  return finishCommitWait(ctx, ws, state, outcome);
}

async function finishCommitWait(ctx, ws, state, { receipt, gone, superseded }) {
  // The saved bytes were not sent again, since a claim of these hashes is on the chain by another transaction. Their
  // nonce was not shown to be used, so the folder keeps them until that claim is adopted: at its depth, where its
  // log said. One that a reorganization takes out again leaves the folder as it was (TX_PENDING), bytes and all.
  if (superseded) return adoptLogged(ctx, ws, state, superseded.existing, superseded.from);
  if (gone) {
    // what took the nonce may be the claim itself, sent some other way: looked for from where the anchor proves the
    // logs complete, whatever the kind. A claim found is adopted; with none found the folder is prepared again, and
    // what is signed next is asked what any signature is.
    const at = await anchoredClaim(ctx, ws, state);
    if (at.existing) return adoptLogged(ctx, ws, state, at.existing, at.from);
    // Where --restart set files aside, what took the nonce may be a claim of those files, paid already: the folder
    // signs nothing more. Nothing is saved for it, before the message or after: the signed bytes stay, and every
    // later run reads from the chain that their nonce is gone and from the disk that files are set aside, and ends
    // here again. So no process that stops anywhere on the way leaves a folder that signs.
    const stop = replacedAfterRestart(ws);
    if (stop) {
      // And it is said only once it cannot be undone: the transaction that took the nonce is in a finalized block.
      // Before that a reorganization can free the nonce again, and the next run would send the saved commit from a
      // folder that had said it signs nothing more. So until then the run says what is true, that the commit is not
      // mined, and is to be made again (TX_PENDING, exit 4).
      const taken = await nonceTakenForGood(ctx, state);
      if (taken !== 'final') {
        const why = taken === 'not-final' ? 'in a block that is not final yet' : 'and this node names no finalized block, so it cannot show that the block is final: use an RPC that does';
        throw fail('TX_PENDING', `Transaction ${state.commitTx.hash}. Another transaction of this wallet has its nonce, ${why}. If that stands, this folder signs nothing more, since --restart set files aside here, and this command says so then. Nothing was signed or sent.`);
      }
      throw fail('COMMIT_REPLACED', stop);
    }
    // nothing is signed any more, so the folder names no kind: the next run's flag says which is sent
    const next = { ...withKind(state, false), stage: 'prepared', commitTx: null };
    ws.saveState(next);
    return next;
  }
  if (receipt.status !== 1) {
    const hash = state.commitTx.hash;
    const next = { ...withKind(state, false), stage: 'prepared', commitTx: null };
    ws.saveState(next);
    throw fail('COMMIT_REVERTED', `${await revertedReason(ctx, hash, state)} Transaction ${hash}.`);
  }
  await ctx.step('commit:mined');
  const log = receipt.logs.filter((l) => l.address.toLowerCase() === ctx.contract.toLowerCase()).map((l) => ctx.parseLog(l)).find((e) => CLAIM_MADE.includes(e?.name));
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

/**
 * The chain's rules for a commit now, or with `late` for a late claim, and the wallet. The price is commitPrice's for
 * both. A commit needs a listing that takes commits and allows the hunter; a late claim one that takes late claims,
 * which the lens says (acceptsLateClaims: ClaimLogic.commit's own rule), and it has no allowlist. The wrong kind for
 * the listing is refused here, before anything is drawn, pinned or signed, with a text that names the other.
 * @returns {Promise<bigint>} the live price
 */
async function commitPreflight(ctx, listingId, hunter, late = false) {
  const price = await ctx.read('commitPrice', [listingId]);
  if (late) {
    if (!await ctx.read('acceptsLateClaims', [listingId])) {
      throw fail(await ctx.read('acceptsCommits', [listingId]) ? 'LISTING_TAKES_COMMITS' : 'NO_LATE_CLAIMS', `Listing ${listingId}.`);
    }
  } else {
    if (!await ctx.read('acceptsCommits', [listingId])) {
      // which refusal it is, and no more: a lens that cannot say leaves the refusal a commit always had; an RPC that
      // did not answer is said as that, since a run again may get the answer
      const lateOnly = await ctx.read('acceptsLateClaims', [listingId]).catch((err) => {
        if (err.code === 'CONTRACT_REFUSED') return false;
        throw err;
      });
      throw fail(lateOnly ? 'LATE_CLAIMS_ONLY' : 'LISTING_NOT_ACCEPTING', `Listing ${listingId}.`);
    }
    if (!await ctx.read('isAllowed', [listingId, hunter])) throw fail('NOT_ALLOWED');
  }
  const fee = await ctx.feeCap();
  const balance = await ctx.rpc(() => ctx.provider.getBalance(hunter));
  if (balance < price + (COMMIT_GAS_ALLOWANCE + DISCLOSE_GAS_ALLOWANCE) * fee.maxFeePerGas) throw fail('INSUFFICIENT_FUNDS', 'Commit and disclose together need the price and their gas.');
  return price;
}

/**
 * A late claim is signed only in a folder that never set a claim's files aside (--restart does that). Such a folder
 * knows nothing of the earlier files: what protected their claim while the new one was signed (the nonce --restart
 * read, the block it read it at) is gone when that run ends, a reorganization can change which claim a nonce made,
 * and the reads before a late claim look for the folder's own two hashes alone. So a claim of the earlier hashes,
 * sent some other way and mined afterwards, would be followed by a second bond, and left without its keys. A new
 * folder has neither problem: the old one stays whole, and any run of it finds and discloses its claim. For the same
 * reason --restart does not start a late claim over (runCommit).
 */
function lateNeedsNewFolder(ws, state = null) {
  const stamps = ws.setAsideClaims();
  if (stamps.length === 0) return;
  // every claim this folder has held is named, the prepared one with them: any of them may be the one that is paid
  const own = state ? ', and of the prepared claim in state.json' : '';
  throw fail('LATE_NEEDS_NEW_FOLDER', `This folder holds files that --restart set aside (${asideNames(stamps)}). Before a new folder pays for a late claim, look for a claim of each of them${own}: ${SAVED_STATE_NAMES} Look among that wallet's transactions, mined or pending. A claim that exists is paid and needs its files, and a late claim from a new folder would pay a second bond beside it.`);
}

const asideNames = (stamps) => stamps.map((stamp) => `*.set-aside-${stamp}`).join(', ');
// Whose claim a saved state is: the wallet that prepared it, which need not be the one a later run has.
const SAVED_STATE_NAMES = 'every one of those state.json files names the wallet (hunter), the chain, the contract, the listing and the two hashes of one claim.';

/**
 * What START_UNPROVEN adds where it sends the hunter to a new folder and the folder holds files that --restart set
 * aside: the claim that is paid may be of one of those, so each is to be looked for too. Where it says to read the
 * logs through another RPC, it sends nobody to a new folder, and nothing is added.
 */
function withSetAside(ws, unproven) {
  const stamps = ws.setAsideClaims();
  if (!unproven || !unproven.endsWith(NEW_FOLDER) || stamps.length === 0) return unproven;
  return `${unproven} This folder also holds files that --restart set aside (${asideNames(stamps)}): look for a claim of each of those too, before a new folder pays. And ${SAVED_STATE_NAMES}`;
}

/** What COMMIT_REPLACED ends with in a folder that set nothing aside: a run again signs a new commit, as it always did. */
const SIGN_AGAIN = 'Run commit again: it signs a new one.';

/**
 * What COMMIT_REPLACED ends with in a folder where --restart set files aside (the owner's decision of 2026-11-24).
 * The transaction that took the nonce may be a claim of those files' hashes, sent some other way: that claim is
 * paid, and another signature here would pay again while its disclosure window runs. The folder cannot tell, so it
 * signs nothing more (finishCommitWait), and the text says where each case goes from here:
 *
 *   - such a claim gets its files back by hand: a set-aside claim's files, under their plain names in a private
 *     folder, are a prepared folder, and commit there looks for the claim as it does in any prepared folder
 *     (anchoredClaim). The text says what that search covers and what it does not: from the block the set was
 *     prepared at, or, after a reorganization below it, from the finalized block its anchor saved. A set an earlier
 *     version prepared has no anchor, and a claim that a reorganization put below its block is not found. The text
 *     promises nothing for that case: the tool has no command for it.
 *   - anything else: the commit is prepared in a new folder, with one copy of the claim's files.
 */
function replacedAfterRestart(ws) {
  const stamps = ws.setAsideClaims();
  if (stamps.length === 0) return null;
  return `This folder signs nothing more: --restart set files aside here (${asideNames(stamps)}), and the transaction that took the nonce may be a claim of the two hashes in one of those state.json files, sent some other way. Before a new folder pays, look for a claim of each of them, and of this folder's own two hashes (state.json), mined or pending: ${SAVED_STATE_NAMES} Look among that wallet's transactions: the one that took the nonce, and those after it. A claim that exists is paid, its disclosure window is running, and it needs its files. For a claim of files that were set aside: make a new claim folder with a .verdikta-claim folder in it, of mode 0700; copy that stamp's archive.zip, keys.json, ciphertext.age and state.json there under those plain names, and anchor.json too where the stamp has one, each with its mode (cp -p); and run commit on that folder, without --yes. That run looks for the claim in the logs from the block the set was prepared at (startBlock in its state.json), or, where the chain was reorganized below that block and the set's anchor.json holds a finalized block that still stands, from that block, which needs an RPC that serves the logs from there; and it discloses the claim it finds. If it prints a commit's terms and asks for --yes instead, it did not find the claim: do not give --yes there, which would pay for a second one. It does not find a claim below that: for a set with no anchor.json, one that a reorganization put below startBlock. If no such claim exists, prepare the commit in a new folder: copy finding.json, report.md and the patches there, and run commit on it.`;
}

/**
 * Whether the transaction that took a saved commit's nonce is there for good: the wallet's count at the node's
 * finalized block is past that nonce. Until then a reorganization can take that transaction out and leave the nonce
 * free, and the saved commit can still go out, so nothing is to be said that only holds if it cannot.
 * @returns {Promise<'final'|'not-final'|'no-finalized-block'>}
 */
async function nonceTakenForGood(ctx, state) {
  const head = await blockIdAt(ctx);
  const finalized = head ? await finalizedBlockOf(ctx, head) : null;
  if (!finalized) return 'no-finalized-block';
  return await countAt(ctx, state.hunter, finalized.number) > state.commitTx.nonce ? 'final' : 'not-final';
}

/**
 * Signs and sends the commit, or with `late` the late claim: never twice, and only with everything on disk.
 * @param {bigint} quoted the price this run's notice named: a live price that differs is said before it is signed
 */
async function sendCommit(ctx, ws, state, listingId, late, quoted) {
  // the one place a late claim is signed: never in a folder that has set a claim's files aside (lateNeedsNewFolder)
  if (late) lateNeedsNewFolder(ws, state);
  // A late claim's nonce and the logs are read at one block (nonceAndClaimAt). Only a late claim asks this: a
  // commit is signed as it always was, at the wallet's next nonce counting what is pending.
  const at = late ? await nonceAndClaimAt(ctx, ws, state) : { existing: await findCommitted(ctx, state) };
  if (at.existing) return adoptLogged(ctx, ws, state, at.existing, at.from);
  // The logs hold no claim of these hashes, and that is proof only from a block the anchor vouches for.
  if (late && at.unproven) throw fail('START_UNPROVEN', at.unproven);
  // No log of it is not proof for a late claim: one sent some other way and not in those blocks has none there.
  if (late && at.pending > at.nonce) throw fail('WALLET_BUSY', 'A late claim signed now could be a second one, for a second bond.');

  readProvenFiles(ctx, ws, state);
  const price = await commitPreflight(ctx, listingId, state.hunter, late); // read just before signing: the live fee
  // the amount printed is the amount sent: a fee that moved since the terms were said is said before it is signed
  if (price !== quoted) ctx.notice(priceMovedNotice({ late, quoted, price }));
  const data = ctx.encode(late ? 'lateClaim' : 'commit', [listingId, state.archiveSha256, state.ciphertextSha256]);
  let estimate;
  try {
    estimate = await ctx.estimate({ data, value: price });
  } catch (err) {
    if (err.code === 'CONTRACT_REFUSED' && !late) throw fail('LISTING_NOT_ACCEPTING', err.detail);
    // a late claim's own refusal, should the listing have changed since the read above; any other is the contract's, as said
    if (err.code === 'CONTRACT_REFUSED' && err.detail === 'not accepting late claims') throw fail('NO_LATE_CLAIMS', `Listing ${listingId}.`);
    throw err;
  }
  const rec = await ctx.sign({ data, value: price, gasLimit: (estimate * 5n) / 4n + 10000n, ...(late ? { nonce: at.nonce } : {}) });
  // The files are private and on disk, and these bytes are saved, with their kind, before any of it can leave.
  const next = { ...withKind(state, late), stage: 'commit-signed', commitTx: rec };
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
    // a late claim (node P43): the chain's word, whatever flag this run had
    late: claim.late === true,
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

/** The steps before a commit, or a late claim, may be sent: the listing, the claim's files, the warning, the acknowledgement. */
async function readyToCommit(ctx, ws, state, listingId, hunter, acknowledge, late) {
  const listing = await readListing(ctx, listingId);
  const inputs = readClaimInputs(ws.claimDir);
  const { finding, warnings } = checkClaimInputs(inputs, listing.spec);
  if (state) {
    // (its text names --restart, which starts a commit over and not a late claim: LATE_NEEDS_NEW_FOLDER)
    if (sha256Hex0x(buildClaimArchive(inputs)) !== state.archiveSha256) throw fail('INPUTS_CHANGED', late ? 'With --late, prepare the changed files in a new folder instead: --restart does not start a late claim over.' : undefined);
    if (archiveDisclosureKeyHex(listing.spec) !== state.disclosureKey) throw fail('ARCHIVE_MISMATCH');
  }
  const price = await commitPreflight(ctx, listingId, hunter, late);
  // Before any key is drawn, and on every run from which a commit may go out.
  ctx.notice(commitNotice(termsForNotice(listing, price, { late })));
  const { baseline } = runnerFilesOf(listing.listingBytes, listing.spec);
  // report.md's requirement section is advice (owner, 2026-11-10, Q73 #2): said again here, never a refusal
  for (const w of [...warnings, ...lintObservable({ finding, pocPatch: inputs.pocPatch, baseline }), ...requirementWarnings(inputs.report)]) ctx.notice(`${w.code}: ${w.detail}`);
  if (!acknowledge) throw fail('NEEDS_ACKNOWLEDGEMENT');
  return { listing, inputs, price };
}

/**
 * commit, or a resume of one; with `late` (--late, node P43) a late claim, on a listing that takes those and no
 * commit. See the top of this file.
 */
export async function runCommit(ctx, { claimDir, listingId, late: lateFlag = false, acknowledge = false, restart = false, acceptUnreadPin = false }) {
  const late = Boolean(lateFlag);
  const hunter = await ctx.hunterAddress();
  // The warning and the diligence text must reach someone: a library caller gives them somewhere to go.
  if (!ctx.onNotice) throw fail('USAGE', 'commit needs onNotice, for what must be said before anyone pays.');
  await ctx.ensureChain();
  const ws = openWorkspace(claimDir);
  return ws.withLock(async () => {
    let state = ws.loadState();
    if (state) checkBinding(state, { ...bindingOf(ctx, hunter), listingId: listingId ?? undefined });
    // A prepared folder's claim may be on the chain already, sent some other way with these two hashes. That is asked
    // first: the claim has its bond, so nothing may refuse the run (the listing, the wallet's balance, the flag) or
    // remove its keys (--restart) before it is found and disclosed.
    const lookFirst = async () => {
      // --restart removes the keys, so it asks more: a claim of these hashes that is not in the blocks read has no
      // log to be found by, and would lose them. A prepared folder names no kind, so this is asked whatever the flag.
      // The logs are read from where the anchor proves them complete, whatever the flag: a claim that exists is
      // adopted before the flag is read. With --late, a folder the anchor cannot vouch for goes no further: no terms
      // for a late claim that would not be signed, and nothing set aside by --restart. Without it, a run is never
      // refused for its anchor.
      const at = restart ? await nonceAndClaimAt(ctx, ws, state) : await anchoredClaim(ctx, ws, state);
      if (at.existing) state = await adoptLogged(ctx, ws, state, at.existing, at.from);
      else if (late && at.unproven) throw fail('START_UNPROVEN', at.unproven);
      else if (restart && at.pending > at.nonce) throw fail('WALLET_BUSY', 'It may be this folder\'s claim, and --restart would remove the keys it needs.');
      return at;
    };
    if (state?.stage === 'prepared') await lookFirst();
    if (state && restart && state.stage !== 'prepared') throw fail('RESTART_REFUSED');
    // A late claim is not started over in a folder, nor signed in one that has set a claim's files aside
    // (lateNeedsNewFolder): refused here, before the terms are said and before any key is drawn. A claim of the
    // folder's own hashes was looked for first, and one that exists is adopted whatever the flags.
    if (late && (!state || state.stage === 'prepared')) {
      lateNeedsNewFolder(ws, state);
      if (state && restart) throw fail('LATE_NEEDS_NEW_FOLDER', 'No claim of this folder\'s two hashes was found, mined or pending, and any run of commit here still finds and discloses one that appears: if you sent them some other way, wait for that claim, since a late claim from a new folder would pay a second bond beside it.');
    }
    // --restart starts over only once the new claim may go out (below): until then the prepared one is the active one
    const startOver = Boolean(state && restart);
    if ((!state || startOver) && (listingId === undefined || listingId === null)) throw fail('USAGE', 'A first commit needs --listing <id>.');
    const id = BigInt(state ? state.listingId : listingId);

    // (saved bytes whose nonce went to another transaction, with no claim of these hashes made: the folder is prepared
    // again and this run signs anew, as it always did; where --restart set files aside it ends here, COMMIT_REPLACED)
    if (state?.stage === 'commit-signed') state = await settleCommit(ctx, ws, state);
    // (--restart's new claim is checked as a first one is, with no state: its files may be other files)
    if (!state || state.stage === 'prepared') {
      const { listing, inputs, price } = await readyToCommit(ctx, ws, startOver ? null : state, id, hunter, acknowledge, late);
      if (startOver) {
        // Only here, after everything that can refuse the run: the listing may take no commit, the wallet may not
        // hold the price, --yes may be missing. A refusal before this leaves the prepared folder whole, with its
        // keys. Those reads took their time (the listing's files are fetched), so the old files' claim is looked for
        // once more, the last thing before they are set aside: one mined meanwhile is adopted, and its files stay
        // the active ones.
        await lookFirst();
        if (state.stage !== 'prepared') throw fail('RESTART_REFUSED');
        // And set aside, never deleted: no read can see a claim of these hashes that someone holds and has not sent
        // yet. What starts over here is a commit; a late claim is never signed in this folder from now on.
        ws.setAsidePrepared();
        state = null;
      }
      if (!state) state = await prepare(ctx, ws, listing, inputs, hunter, id);
      state = await sendCommit(ctx, ws, state, id, late, price);
      // The signed bytes' nonce went to another transaction while this run waited, and no claim came of it: there is
      // none to disclose. The folder is prepared again, and a run again signs anew. (Where --restart set files aside
      // the run has ended before this, with the folder still signed: finishCommitWait.)
      if (state.stage === 'prepared') throw fail('COMMIT_REPLACED', SIGN_AGAIN);
    }
    // The claim exists, and is the kind the chain says. A run whose flag says the other kind goes on all the same,
    // since the bond is paid and only the disclosure keeps it, and says which kind the folder holds.
    if ((state.late === true) !== late) ctx.notice(kindNotice({ claimId: state.claimId, late: state.late === true }));
    while (state.stage !== 'disclosed') state = await disclose(ctx, ws, state, { acceptUnreadPin });
    const result = await resultOf(ctx, state);
    // What this run says of the reveal, recorded (node P32): status compares the chain's deadline with it, and says
    // when a release or a roll-forward moved it earlier than the hunter was told.
    const told = result.revealDeadline === null ? null : { revealableAt: String(result.revealableAt), revealDeadline: String(result.revealDeadline), earliest: result.revealDeadlineEarliest };
    if (told && JSON.stringify(state.told) !== JSON.stringify(told)) ws.saveState({ ...state, told });
    return result;
  });
}
