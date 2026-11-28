// Keeping a claim's content available (review 2026-11-27, item 2). A claim's ciphertext (from disclose)
// and its plaintext archive (from reveal) are pinned by the hunter alone, and every round of the claim
// has its jury fetch them: the claim round, the maker's dispute, the hunter's appeal and the escrow-paid
// confirmations. A jury that cannot fetch them does not commit, and the round ends with no verdict. So a
// hunter with one favourable verdict could take the content offline and have the dispute and both
// confirmations end with none, after which settle applies that first verdict.
//
// So this site pins what it can fetch: from the Disclosed and Revealed events, while the claim is
// unresolved. Once a jury has been able to read a claim, this site has too, and no later round depends
// on the hunter. It cannot help a round whose content was never online (the contract's one re-trigger
// per claim round bounds that), and it is one more copy, not the only one: the maker has the ciphertext.
//
// The bytes come from the gateways under a byte cap (the CID is the hunter's to choose) and go to the
// pinning backend, which must answer the SAME CID: a raw sha2-256 CID always does; another form does
// when the backend chunks as the hunter's pinner did (the tool's and this server's backends are the
// same services with the same settings). If it answers another CID the content is not kept under the
// claim's, and that is stored and logged, not retried: the bytes would be chunked the same way again.
// A fetch or a pin that fails is retried with a backoff. Beside the indexer, one run at a time, a
// limited number per run, never inside a sync or a request.
const RETRY_MAX_MS = 6 * 3600_000;
export const MAX_KEPT_PER_RUN = 4;
const RESOLVED = new Set(['Settled', 'Expired']);

/**
 * The CIDs to keep: every unresolved claim's ciphertextCid and bcid, from the events in chain order.
 * @param {object[]} events - store.state.events
 * @returns {Map<string, { claimId: string, role: 'ciphertext'|'claim' }>}
 */
export function contentOf(events) {
  const byClaim = new Map();
  for (const e of events) {
    const id = e.args?.claimId;
    if (id === undefined) continue;
    const key = String(id);
    if (e.name === 'Disclosed' && typeof e.args.ciphertextCid === 'string') byClaim.set(key, { ...(byClaim.get(key) ?? {}), ciphertext: e.args.ciphertextCid });
    else if (e.name === 'Revealed' && typeof e.args.bcid === 'string') byClaim.set(key, { ...(byClaim.get(key) ?? {}), claim: e.args.bcid });
    else if (RESOLVED.has(e.name)) byClaim.delete(key);
  }
  const wanted = new Map();
  for (const [claimId, cids] of byClaim) {
    for (const role of ['ciphertext', 'claim']) {
      if (cids[role] && !wanted.has(cids[role])) wanted.set(cids[role], { claimId, role });
    }
  }
  return wanted;
}

/**
 * Pins the content of unresolved claims that has no answer yet or whose wait is over: at most
 * MAX_KEPT_PER_RUN per call, the ones never tried first, then the ones waiting longest.
 * @param {object} o
 * @param {(cid: string) => Promise<Buffer>} o.fetchContent - gateway fetch, byte-capped
 * @param {{ backend: string, pin(bytes: Buffer, o?: { name?: string }): Promise<string> }} o.pinner
 * @param {import('./store.js').StateStore} o.store
 * @param {() => number} o.now - the clock, ms
 * @param {number} o.retryMs - the first wait after a failure (doubling per failure)
 * @param {object} o.logger
 */
export async function keepClaimContent({ fetchContent, pinner, store, now, retryMs, logger }) {
  const wanted = contentOf(store.state.events);
  const known = store.state.kept ?? {};
  const t = now();
  const due = [...wanted.keys()]
    .filter((cid) => !known[cid] || (known[cid].pending && known[cid].nextAt <= t))
    .sort((a, b) => (known[a]?.nextAt ?? 0) - (known[b]?.nextAt ?? 0));
  for (const cid of due.slice(0, MAX_KEPT_PER_RUN)) {
    const { claimId, role } = wanted.get(cid);
    let answer;
    try {
      const bytes = Buffer.from(await fetchContent(cid));
      const pinned = await pinner.pin(bytes, { name: `claim-${claimId}-${role}` });
      if (pinned === cid) {
        answer = { kept: true, bytes: bytes.length, at: now() };
        logger.info(`keep: claim ${claimId}'s ${role} ${cid} is pinned (${pinner.backend}, ${bytes.length} bytes)`);
      } else {
        answer = { kept: false, error: 'KEEP_OTHER_CID', at: now() };
        logger.warn(`keep: claim ${claimId}'s ${role} ${cid} could not be kept under its CID: ${pinner.backend} gave its bytes another one`);
      }
    } catch (err) {
      const attempts = (known[cid]?.attempts ?? 0) + 1;
      const delay = Math.min(RETRY_MAX_MS, retryMs * 2 ** (attempts - 1));
      answer = { pending: true, attempts, nextAt: now() + delay };
      // a PinError's text never holds a credential (pinning/index.js); a gateway's is cut short
      logger.warn(`keep: claim ${claimId}'s ${role} ${cid} is not pinned yet (${String(err?.code ?? err?.message ?? err).slice(0, 120)}); retry in ${Math.round(delay / 1000)} s`);
    }
    if (!store.locked) return; // the site closed while this ran
    store.transact((s) => {
      s.kept = { ...(s.kept ?? {}), [cid]: answer };
    });
  }
  // answers for claims that have resolved are dropped: the map does not grow with the chain's history
  const stale = Object.keys(store.state.kept ?? {}).filter((cid) => !wanted.has(cid));
  if (stale.length && store.locked) {
    store.transact((s) => {
      for (const cid of stale) delete s.kept[cid];
    });
  }
}
