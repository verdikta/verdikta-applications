// What a feed entry takes from its listing archive (design §15: the image and the scope): the
// archive is fetched by the listingCid the chain stores and its code_review.json is read through
// its manifest, straight from the ZIP's central directory and never extracted: the archive is
// the maker's, so the download, the directory and each member read are all held to byte caps
// (zipRead.js). As the arbiters' ArchiveService does, an archive whose members all sit in one
// top-level folder is read from that folder. An archive whose CID is the raw sha2-256 form must
// hash to it. What it says is kept
// in the store by CID (content addressed, so a read never goes stale); a fetch that failed is
// retried with a backoff. The archive is trusted for a listing's image and scope only when it is
// that listing: its repository, commit and disclosure key must be the ones the chain stores
// (archiveFields checks, per listing, since two listings may name one CID).
import { DEFAULT_IPFS_GATEWAYS, codeReview } from '../common.js';
import { disclosureKeyBytes32 } from '../listing/listParams.js';
import { isRawSha256Cid, rawCid } from '../pinning/cid.js';
import { ZipError, readZipMember, zipDirectory } from '../zipRead.js';

const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const MANIFEST_MAX_BYTES = 64 * 1024;
const SPEC_MAX_BYTES = 1024 * 1024;
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

/** The folder the archive's files sit in: the root, or its one top-level folder (as ArchiveService). */
function rootOf(entries) {
  if (entries.has('manifest.json')) return '';
  const files = [...entries.keys()].filter((n) => !n.endsWith('/'));
  const tops = new Set(files.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/') + 1) : '')));
  if (tops.size !== 1) return null;
  const [top] = tops;
  return top && entries.has(`${top}manifest.json`) ? top : null;
}

function readJson(bytes, entries, name, maxBytes) {
  const entry = entries.get(name);
  if (!entry) throw new ZipError('ZIP_INVALID', `${name} is not in the archive`);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readZipMember(bytes, entry, maxBytes)));
}

/**
 * What an archive's code_review.json says, from its bytes.
 * @param {Buffer} bytes
 * @param {string} listingCid
 * @returns {{ ok: true, repo: string, baseCommit: string, disclosureKey: string, image: string|null, platform: string|null, scope: object } | { ok: false, error: string }}
 */
export function readListingArchive(bytes, listingCid, { maxBytes = Infinity } = {}) {
  if (bytes.length > maxBytes) return { ok: false, error: 'ARCHIVE_TOO_LARGE' };
  if (isRawSha256Cid(listingCid) && rawCid(bytes) !== listingCid) return { ok: false, error: 'ARCHIVE_NOT_CID' };
  let spec;
  try {
    const entries = zipDirectory(bytes);
    const root = rootOf(entries);
    if (root === null) return { ok: false, error: 'ARCHIVE_INVALID' };
    const manifest = readJson(bytes, entries, `${root}manifest.json`, MANIFEST_MAX_BYTES);
    if (typeof manifest?.codeReview !== 'string' || !PLAIN_NAME.test(manifest.codeReview)) return { ok: false, error: 'ARCHIVE_INVALID' };
    spec = readJson(bytes, entries, `${root}${manifest.codeReview}`, SPEC_MAX_BYTES);
  } catch (err) {
    return { ok: false, error: err?.code === 'ZIP_TOO_LARGE' ? 'ARCHIVE_TOO_LARGE' : 'ARCHIVE_INVALID' };
  }
  if (!spec || typeof spec !== 'object' || !codeReview.validateCodeReviewSpec(spec).ok) return { ok: false, error: 'ARCHIVE_INVALID' };
  let disclosureKey;
  try {
    disclosureKey = disclosureKeyBytes32(spec.stake.disclosureKey);
  } catch {
    return { ok: false, error: 'ARCHIVE_INVALID' };
  }
  const scope = { include: [...spec.stake.scope.include], exclude: [...(spec.stake.scope.exclude ?? [])] };
  return { ok: true, repo: spec.repo, baseCommit: spec.baseCommit, disclosureKey, image: spec.env?.image ?? null, platform: spec.env?.platform ?? null, scope };
}

/**
 * Reads the archives of the listings given (those the feed may show) that the store has no
 * answer for yet, at most MAX_PER_SYNC per call; a failed fetch is stored with its next attempt,
 * counted from when it failed. It runs beside the indexer (site/index.js), never inside a sync.
 * @param {object} o
 * @param {(cid: string) => Promise<Buffer>} o.fetchArchive
 * @param {import('./store.js').StateStore} o.store
 * @param {{ listingCid: string, artifact: object, disclosureKey: string }[]} o.listings
 * @param {() => number} o.now - the clock, ms
 * @param {number} o.maxBytes
 * @param {number} o.retryMs - the first wait after a failure (doubling per failure)
 */
export async function refreshArchives({ fetchArchive, store, listings, now, maxBytes, retryMs, logger }) {
  let tried = 0;
  for (const listing of listings) {
    const known = store.state.archives[listing.listingCid];
    if (known && (known.ok || known.error !== 'ARCHIVE_UNAVAILABLE' || known.retryAt > now())) continue;
    if (tried >= MAX_PER_SYNC) break;
    tried += 1;
    let result;
    try {
      const bytes = Buffer.from(await fetchArchive(listing.listingCid));
      result = readListingArchive(bytes, listing.listingCid, { maxBytes });
    } catch (err) {
      const attempts = (known?.attempts ?? 0) + 1;
      const delay = Math.min(RETRY_MAX_MS, retryMs * 2 ** (attempts - 1));
      result = { ok: false, error: 'ARCHIVE_UNAVAILABLE', attempts, retryAt: now() + delay };
      logger.warn(`feed: listing archive ${listing.listingCid} could not be fetched (${String(err?.message ?? err).slice(0, 200)}); retry in ${Math.round(delay / 1000)} s`);
    }
    if (!store.locked) return; // the site closed while this fetch ran
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
