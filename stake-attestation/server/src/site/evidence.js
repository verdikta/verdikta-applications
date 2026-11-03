// The justifications the record reads (node P10; src/record/integrity.js counts from the answers). A
// justification is untrusted text from IPFS: anyone who gets a CID recorded chooses it. So only a settled
// DUPLICATE's upload is ever fetched, the download and the reader are both held to byte caps, a run reads
// a limited number, and what is kept is the outcome of the read: known check names and a settlement in
// its writer's form, never other text from the upload. It runs beside the indexer (site/index.js), one run at a time and never inside a sync or a
// request. Answers are kept by CID: a CID names its content, so a reorg cannot hand one claim another's
// answer, and an answer is final.
//
// A read that fails is "could not read": a gateway down, a file over the cap, or an answer with no
// justification in it (a gateway's error can answer 200, as a page or as JSON). It is tried again with a
// backoff, counted from the failure, up to a cap, and until then the claim is a plain DUPLICATE, never an
// integrity failure. An upload with a justification is read, and final: it either has an integrity block
// in the writer's form or says `other`, with the settlement and the known checks its block states, so
// arbiters that differ can be told from arbiters that agree. A gateway's bytes are checked against the CID only when it names
// their hash (createGatewayFetcher): a dag-pb CID's aren't.
import { MAX_JUSTIFICATION_UPLOAD_BYTES, integrityFailureOf, justificationCidsOf, readExecutionEvidence } from '@verdikta/stake-attestation-shared';

import { codeReview } from '../common.js';
import { isSettledDuplicate } from '../record/integrity.js';
import { createGatewayFetcher } from './archives.js';

export const MAX_FETCHES_PER_RUN = 8;
const RETRY_MAX_MS = 6 * 3600_000;

/** The production fetcher: the feed's gateways and timeout, the download stopped at the upload's cap. */
export const createJustificationFetcher = ({ gateways, timeoutMs }, logger, options) => createGatewayFetcher({ gateways, timeoutMs, maxBytes: MAX_JUSTIFICATION_UPLOAD_BYTES }, logger, options);

/**
 * What an upload says of integrity.
 * @param {Buffer} bytes
 * @returns {{ says: 'integrity', checks: string[] } | { says: 'other', settlement: string|null, checks: string[]|null } | null}
 *   `settlement` and `checks`: what the block states, as the reader for a person takes it, known names only,
 *   or null for no block; null: it could not be read
 */
export function readUpload(bytes) {
  if (bytes.length > MAX_JUSTIFICATION_UPLOAD_BYTES) return null;
  let upload;
  try {
    upload = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const justification = upload?.justification;
  if (typeof justification !== 'string') return null;
  const integrityChecks = codeReview.INTEGRITY_CHECKS;
  const checks = integrityFailureOf(justification, { integrityChecks });
  if (checks) return { says: 'integrity', checks };
  const block = readExecutionEvidence(justification, { integrityChecks });
  return { says: 'other', settlement: block?.settlement ?? null, checks: block?.integrityFailedChecks ?? null };
}

/**
 * Reads the justifications of the settled duplicates given that have no answer yet or whose wait is
 * over: at most MAX_FETCHES_PER_RUN, the ones never asked first, then the ones waiting longest.
 * @param {object} o
 * @param {(cid: string) => Promise<Buffer>} o.fetchJustification
 * @param {import('./store.js').StateStore} o.store
 * @param {Iterable<object>} o.claims - the projection's claims
 * @param {() => number} o.now - the clock, ms
 * @param {number} o.retryMs - the first wait after a failure (doubling per failure)
 * @param {object} o.logger
 */
export async function refreshEvidence({ fetchJustification, store, claims, now, retryMs, logger }) {
  const wanted = new Set();
  for (const claim of claims) {
    if (isSettledDuplicate(claim)) for (const cid of justificationCidsOf(claim.justificationCid) ?? []) wanted.add(cid);
  }
  const known = store.state.evidence ?? {};
  const t = now();
  const due = [...wanted]
    .filter((cid) => !known[cid] || (known[cid].unread && known[cid].nextAt <= t))
    .sort((a, b) => (known[a]?.nextAt ?? 0) - (known[b]?.nextAt ?? 0));
  for (const cid of due.slice(0, MAX_FETCHES_PER_RUN)) {
    let reading = null;
    let why = 'no justification in it, or over the cap';
    try {
      reading = readUpload(Buffer.from(await fetchJustification(cid)));
    } catch (err) {
      why = String(err?.message ?? err).slice(0, 200);
    }
    if (!store.locked) return; // the site closed while this read ran
    if (!reading) {
      const attempts = (known[cid]?.attempts ?? 0) + 1;
      const delay = Math.min(RETRY_MAX_MS, retryMs * 2 ** (attempts - 1));
      reading = { unread: true, attempts, nextAt: now() + delay };
      logger.warn(`record: justification ${cid} could not be read (${why}); retry in ${Math.round(delay / 1000)} s`);
    }
    store.transact((s) => {
      s.evidence ??= {};
      s.evidence[cid] = reading;
    });
  }
}
