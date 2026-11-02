// What a feed entry takes from its listing archive (design §15: the image and the scope): the
// archive is fetched by the listingCid the chain stores, extracted with @verdikta/common's
// ArchiveService as the arbiters extract it, and its code_review.json is read through the
// manifest. An archive whose CID is the raw sha2-256 form must hash to it. What it says is kept
// in the store by CID (content addressed, so a read never goes stale); a fetch that failed is
// retried with a backoff. The archive is trusted for a listing's image and scope only when it is
// that listing: its repository, commit and disclosure key must be the ones the chain stores
// (archiveFields checks, per listing, since two listings may name one CID).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveService, DEFAULT_IPFS_GATEWAYS, codeReview } from '../common.js';
import { disclosureKeyBytes32 } from '../listing/listParams.js';
import { isRawSha256Cid, rawCid } from '../pinning/cid.js';

const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const RETRY_MAX_MS = 6 * 3600_000;
const MAX_PER_SYNC = 8;

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`the archive is larger than ${maxBytes} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`the archive is larger than ${maxBytes} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The production fetcher: GET <gateway>/ipfs/<cid> on the operator's gateways (SA_IPFS_GATEWAYS)
 * and then @verdikta/common's (the library owns the gateway order), each with a timeout and a
 * byte cap that stops the download, since the CID is the maker's to choose. A raw sha2-256 CID's
 * bytes must hash to it; another gateway is tried when they do not.
 */
export function createGatewayFetcher({ gateways, timeoutMs, maxBytes }, logger = quiet, { fetch = globalThis.fetch } = {}) {
  const order = [...new Set([...gateways, ...DEFAULT_IPFS_GATEWAYS].map((g) => g.replace(/\/+$/, '')))];
  return async (cid) => {
    if (!/^[0-9A-Za-z]{1,100}$/.test(cid)) throw new Error('not a CID');
    let last = 'no gateway answered';
    for (const gateway of order) {
      try {
        const response = await fetch(`${gateway}/ipfs/${cid}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/octet-stream, application/zip, */*' } });
        if (!response.ok) {
          last = `${new URL(gateway).host} answered HTTP ${response.status}`;
          continue;
        }
        const bytes = await readCapped(response, maxBytes);
        if (isRawSha256Cid(cid) && rawCid(bytes) !== cid) {
          last = `${new URL(gateway).host} answered bytes that are not ${cid}`;
          continue;
        }
        return bytes;
      } catch (err) {
        last = `${new URL(gateway).host}: ${err?.name === 'TimeoutError' ? 'timed out' : String(err?.message ?? err).slice(0, 120)}`;
        if (/larger than/.test(last)) throw new Error(last);
      }
    }
    logger.debug?.(`feed: no gateway served ${cid}: ${last}`);
    throw new Error(last);
  };
}

function readMember(root, name) {
  if (typeof name !== 'string' || !PLAIN_NAME.test(name)) return null;
  const file = path.join(root, name);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return fs.readFileSync(file);
}

/**
 * What an archive's code_review.json says, from its bytes.
 * @param {Buffer} bytes
 * @param {string} listingCid
 * @returns {Promise<{ ok: true, repo: string, baseCommit: string, disclosureKey: string, image: string|null, platform: string|null, scope: object|null } | { ok: false, error: string }>}
 */
export async function readListingArchive(bytes, listingCid, { workDir = os.tmpdir(), maxBytes = Infinity } = {}) {
  if (bytes.length > maxBytes) return { ok: false, error: 'ARCHIVE_TOO_LARGE' };
  if (isRawSha256Cid(listingCid) && rawCid(bytes) !== listingCid) return { ok: false, error: 'ARCHIVE_NOT_CID' };
  const dir = fs.mkdtempSync(path.join(workDir, 'sa-feed-'));
  try {
    let root;
    try {
      root = await new ArchiveService({ fetchFromIPFS: async () => { throw new Error('no fetch'); } }, quiet).extractArchive(bytes, 'listing.zip', dir);
    } catch {
      return { ok: false, error: 'ARCHIVE_INVALID' };
    }
    let spec;
    try {
      const manifest = JSON.parse(readMember(root, 'manifest.json')?.toString('utf8') ?? 'null');
      spec = JSON.parse(readMember(root, manifest?.codeReview)?.toString('utf8') ?? 'null');
    } catch {
      return { ok: false, error: 'ARCHIVE_INVALID' };
    }
    if (!spec || !codeReview.validateCodeReviewSpec(spec).ok) return { ok: false, error: 'ARCHIVE_INVALID' };
    let disclosureKey;
    try {
      disclosureKey = disclosureKeyBytes32(spec.stake.disclosureKey);
    } catch {
      return { ok: false, error: 'ARCHIVE_INVALID' };
    }
    const scope = { include: [...spec.stake.scope.include], exclude: [...(spec.stake.scope.exclude ?? [])] };
    return { ok: true, repo: spec.repo, baseCommit: spec.baseCommit, disclosureKey, image: spec.env?.image ?? null, platform: spec.env?.platform ?? null, scope };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Reads the archives of the listings given (those the feed may show) that the store has no
 * answer for yet, at most MAX_PER_SYNC per call; a failed fetch is stored with its next attempt.
 * @param {object} o
 * @param {(cid: string) => Promise<Buffer>} o.fetchArchive
 * @param {import('./store.js').StateStore} o.store
 * @param {{ listingCid: string, artifact: object, disclosureKey: string }[]} o.listings
 * @param {number} o.now - ms
 * @param {number} o.maxBytes
 * @param {number} o.retryMs - the first wait after a failure (doubling per failure)
 */
export async function refreshArchives({ fetchArchive, store, listings, now, maxBytes, retryMs, logger }) {
  let tried = 0;
  for (const listing of listings) {
    const known = store.state.archives[listing.listingCid];
    if (known && (known.ok || known.error !== 'ARCHIVE_UNAVAILABLE' || known.retryAt > now)) continue;
    if (tried >= MAX_PER_SYNC) break;
    tried += 1;
    let result;
    try {
      const bytes = Buffer.from(await fetchArchive(listing.listingCid));
      result = await readListingArchive(bytes, listing.listingCid, { maxBytes });
    } catch (err) {
      const attempts = (known?.attempts ?? 0) + 1;
      const delay = Math.min(RETRY_MAX_MS, retryMs * 2 ** (attempts - 1));
      result = { ok: false, error: 'ARCHIVE_UNAVAILABLE', attempts, retryAt: now + delay };
      logger.warn(`feed: listing archive ${listing.listingCid} could not be fetched (${String(err?.message ?? err).slice(0, 200)}); retry in ${Math.round(delay / 1000)} s`);
    }
    store.transact((s) => {
      s.archives[listing.listingCid] = result;
    });
  }
}

/**
 * A feed entry's archive fields: the store's answer for its CID, trusted only if the archive is
 * the listing the chain stores (none yet: unavailable).
 * @param {object|undefined} known - store.state.archives[listingCid]
 * @param {{ artifact: { repo: string, baseCommit: string }, disclosureKey: string }} listing - on-chain
 */
export function archiveFields(known, listing) {
  const none = (error) => ({ image: null, scope: null, archive: { ok: false, error } });
  if (!known) return none('ARCHIVE_UNAVAILABLE');
  if (!known.ok) return none(known.error);
  if (known.repo !== listing.artifact.repo || known.baseCommit !== listing.artifact.baseCommit || known.disclosureKey !== listing.disclosureKey.toLowerCase()) {
    return none('ARCHIVE_MISMATCH');
  }
  return { image: known.image, scope: known.scope, archive: { ok: true } };
}
