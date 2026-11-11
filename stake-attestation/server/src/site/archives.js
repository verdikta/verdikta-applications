// What a feed entry takes from its listing archive (design §15: the image and the scope): the
// archive is fetched by the listingCid the chain stores and its code_review.json is read straight from
// the ZIP's central directory and never extracted: the archive is the maker's, so the download, the
// directory and each member read are all held to byte caps (zipRead.js). An archive whose CID is the
// raw sha2-256 form must hash to it. What it says is kept in the store by CID (content addressed, so a
// read never goes stale); a fetch that failed is retried with a backoff. The archive is trusted for a
// listing's image and scope only when it is that listing (src/control/counting.js, per listing, since
// two listings may name one CID).
//
// Node P20: it also gives the listing's document globs (stake.documents), so a hunter sees where its requirements
// are said to be written: none when it names none. An answer stored before they were read is read again, and kept
// as it was while that read fails: its signature and terms were checked, and a gateway that fails says nothing
// against them. Until then its documents are not known (null), never shown as none.
//
// Node P9: reading it also answers "did the builder sign this listing", with the check the hunter
// tool reuses (shared/src/builderSignature.js), under the trust the arbiters apply here: production's
// trusted-builder set, or under dev trust only the keys this site's own signing step made.
import { readSignedListing } from '@verdikta/stake-attestation-shared/builder-signature';
import { documentGlobs } from '@verdikta/stake-attestation-shared/stake-documents';

import { DEFAULT_IPFS_GATEWAYS, codeReview } from '../common.js';
import { disclosureKeyBytes32, signedTerms } from '../listing/listParams.js';
import { isRawSha256Cid, rawCid } from '../pinning/cid.js';

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

/**
 * What an archive says and whether the builder signed it, from its bytes.
 * @param {Buffer} bytes
 * @param {string} listingCid
 * @param {{ maxBytes?: number, devKeys?: object[] }} [o]
 * @returns {{ ok: true, repo: string, baseCommit: string, artifact: object, disclosureKey: string, image: string|null, platform: string|null, scope: object, documents: string[], terms: object, signed: object } | { ok: false, error: string }}
 */
export function readListingArchive(bytes, listingCid, { maxBytes = Infinity, devKeys = null } = {}) {
  if (bytes.length > maxBytes) return { ok: false, error: 'ARCHIVE_TOO_LARGE' };
  if (isRawSha256Cid(listingCid) && rawCid(bytes) !== listingCid) return { ok: false, error: 'ARCHIVE_NOT_CID' };
  const read = readSignedListing(bytes, { codeReview, devKeys });
  if (!read.spec) return { ok: false, error: read.reason };
  const { spec } = read;
  let disclosureKey;
  let terms;
  try {
    disclosureKey = disclosureKeyBytes32(spec.stake.disclosureKey);
    terms = signedTerms(spec, read.knownIssues);
  } catch {
    return { ok: false, error: 'ARCHIVE_INVALID' };
  }
  const scope = { include: [...spec.stake.scope.include], exclude: [...(spec.stake.scope.exclude ?? [])] };
  return {
    ok: true,
    repo: spec.repo,
    baseCommit: spec.baseCommit,
    artifact: spec.artifact ?? { kind: 'repo' },
    disclosureKey,
    image: spec.env?.image ?? null,
    platform: spec.env?.platform ?? null,
    scope,
    documents: documentGlobs(spec).filter((g) => typeof g === 'string'),
    terms,
    signed: read.signed ? { ok: true, role: read.role, filesSha256: read.filesSha256, keyId: read.keyId, trust: read.trust, issuedAt: read.issuedAt } : { ok: false },
  };
}

/**
 * Reads the archives of the listings given (listing and dispute: a listing counts with both) that the
 * store has no answer for yet, at most MAX_PER_SYNC per call; a failed fetch is stored with its next attempt,
 * counted from when it failed. It runs beside the indexer (site/index.js), never inside a sync.
 * @param {object} o
 * @param {(cid: string) => Promise<Buffer>} o.fetchArchive
 * @param {import('./store.js').StateStore} o.store
 * @param {{ listingCid: string, disputeCid: string, artifact: object }[]} o.listings
 * @param {() => number} o.now - the clock, ms
 * @param {number} o.maxBytes
 * @param {number} o.retryMs - the first wait after a failure (doubling per failure)
 * @param {() => object[]} [o.devKeys] - the dev keys that count here
 */
export async function refreshArchives({ fetchArchive, store, listings, now, maxBytes, retryMs, logger, devKeys = () => null }) {
  let tried = 0;
  const cids = [...new Set(listings.flatMap((l) => [l.listingCid, l.disputeCid]))];
  for (const cid of cids) {
    const known = store.state.archives[cid];
    // an answer from before the builder's signature was read is read again, and one from before its documents were
    // (node P20), so a listing that names them is never shown as naming none; that one with a backoff of its own
    const refreshing = Boolean(known?.ok && known.signed && !Array.isArray(known.documents));
    const answered = known && ((known.ok && known.signed && (Array.isArray(known.documents) || known.documentsRetryAt > now())) || (!known.ok && (known.error !== 'ARCHIVE_UNAVAILABLE' || known.retryAt > now())));
    if (answered) continue;
    if (tried >= MAX_PER_SYNC) break;
    tried += 1;
    let result;
    try {
      const bytes = Buffer.from(await fetchArchive(cid));
      result = readListingArchive(bytes, cid, { maxBytes, devKeys: devKeys() });
    } catch (err) {
      if (refreshing) {
        // kept as it was: the listing still counts as it did, and its documents stay unknown until a read succeeds
        const attempts = (known.documentsAttempts ?? 0) + 1;
        const delay = Math.min(RETRY_MAX_MS, retryMs * 2 ** (attempts - 1));
        if (!store.locked) return;
        store.transact((s) => {
          s.archives[cid] = { ...known, documentsAttempts: attempts, documentsRetryAt: now() + delay };
        });
        logger.warn(`feed: listing archive ${cid} could not be read again for its documents (${String(err?.message ?? err).slice(0, 200)}); kept as it was, retry in ${Math.round(delay / 1000)} s`);
        continue;
      }
      const attempts = (known?.attempts ?? 0) + 1;
      const delay = Math.min(RETRY_MAX_MS, retryMs * 2 ** (attempts - 1));
      result = { ok: false, error: 'ARCHIVE_UNAVAILABLE', attempts, retryAt: now() + delay };
      logger.warn(`feed: listing archive ${cid} could not be fetched (${String(err?.message ?? err).slice(0, 200)}); retry in ${Math.round(delay / 1000)} s`);
    }
    if (!store.locked) return; // the site closed while this fetch ran
    store.transact((s) => {
      s.archives[cid] = result;
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
  const none = (error) => ({ image: null, scope: null, documents: null, archive: { ok: false, error } });
  if (!known) return none('ARCHIVE_UNAVAILABLE');
  if (!known.ok) return none(known.error);
  if (known.repo !== listing.artifact.repo || known.baseCommit !== listing.artifact.baseCommit || known.disclosureKey !== listing.disclosureKey.toLowerCase()) {
    return none('ARCHIVE_MISMATCH');
  }
  // documents not yet read from an answer stored before they were: unknown, never none
  return { image: known.image, scope: known.scope, documents: Array.isArray(known.documents) ? known.documents : null, archive: { ok: true } };
}
