// Decrypt-and-check (design §14, erratum E5): the maker's check of a disclosed claim, in the
// browser. In order, each step only if the one before it passed:
//
//   key         the private key the maker gave is the listing's disclosure key (else it is the
//               maker's mistake, not the hunter's: nothing is fetched and nothing can be flagged)
//   fetch       the ciphertext at the CID the hunter disclosed
//   ciphertext  sha256(ciphertext) is the committed ciphertextSha256
//   decrypt     common's decryptDisclosure opens it with the private key
//   plaintext   sha256(plaintext) is the committed archiveHash
//
// A failed fetch is "unavailable"; a failure after it is a bad disclosure. Either may be flagged
// on-chain inside the grace period (flagOffer). The private key goes into decryptDisclosure and
// disclosureRecipient only; it is in no result.
import { DisclosureError, decryptDisclosure, disclosureKeyBytes32, disclosureRecipient, disclosureSha256 } from './disclosure.js';

const STEPS = ['key', 'fetch', 'ciphertext', 'decrypt', 'plaintext'];
const FLAGGABLE = new Set(['bad', 'unavailable']);

function result(verdict, failedAt, { reason = null, plaintext = null } = {}) {
  const steps = {};
  let state = 'passed';
  for (const s of STEPS) {
    if (s === failedAt) {
      steps[s] = 'failed';
      state = 'skipped';
    } else {
      steps[s] = state;
    }
  }
  return { verdict, steps, reason, plaintext };
}

/**
 * @param {object} o
 * @param {string} o.identity - the maker's AGE-SECRET-KEY-1… (surrounding whitespace ignored)
 * @param {string} o.listingKey - the listing's disclosureKey, bytes32 hex
 * @param {{ archiveHash: string, ciphertextSha256: string, ciphertextCid: string }} o.claim
 * @param {(cid: string) => Promise<Uint8Array>} o.fetchCiphertext - throws an Error with a
 *        `reason` ({ key, vars }, STRINGS.check.reasons) when it cannot deliver
 * @returns {Promise<{ verdict: 'match'|'bad'|'unavailable'|'wrongKey'|'badIdentity', steps: object, reason: { key: string, vars: object }|null, plaintext: Uint8Array|null }>}
 */
export async function checkDisclosure({ identity, listingKey, claim, fetchCiphertext }) {
  const key = String(identity).trim();
  let recipient;
  try {
    recipient = disclosureRecipient(key);
  } catch (err) {
    return result('badIdentity', 'key', { reason: { key: 'identity', vars: { reason: err instanceof DisclosureError ? err.code : 'unreadable' } } });
  }
  if (disclosureKeyBytes32(recipient).toLowerCase() !== String(listingKey).toLowerCase()) return result('wrongKey', 'key');

  let ciphertext;
  try {
    ciphertext = await fetchCiphertext(claim.ciphertextCid);
  } catch (err) {
    return result('unavailable', 'fetch', { reason: err?.reason ?? { key: 'network', vars: {} } });
  }

  const ciphertextHash = disclosureSha256(ciphertext);
  if (ciphertextHash !== String(claim.ciphertextSha256).toLowerCase()) {
    return result('bad', 'ciphertext', { reason: { key: 'ciphertext', vars: { actual: ciphertextHash, expected: claim.ciphertextSha256 } } });
  }

  let plaintext;
  try {
    plaintext = decryptDisclosure(ciphertext, key);
  } catch (err) {
    return result('bad', 'decrypt', { reason: { key: 'decrypt', vars: { code: err instanceof DisclosureError ? err.code : 'DECRYPT_FAILED' } } });
  }

  const archiveHash = disclosureSha256(plaintext);
  if (archiveHash !== String(claim.archiveHash).toLowerCase()) {
    return result('bad', 'plaintext', { reason: { key: 'plaintext', vars: { actual: archiveHash, expected: claim.archiveHash } } });
  }
  return result('match', null, { plaintext });
}

/**
 * Whether the page offers flagBadDisclosure: a bad or unavailable copy, not yet flagged, and
 * `now` (the chain's latest block time) before disclosedAt + disclosureGrace, the contract's rule.
 * Times are seconds (bigint or number).
 * @returns {{ offer: boolean, why: null|'notBad'|'alreadyFlagged'|'graceOver', graceEnd: number }}
 */
export function flagOffer({ verdict, now, disclosedAt, disclosureGrace, flagged }) {
  const graceEnd = Number(disclosedAt) + Number(disclosureGrace);
  if (!FLAGGABLE.has(verdict)) return { offer: false, why: 'notBad', graceEnd };
  if (flagged) return { offer: false, why: 'alreadyFlagged', graceEnd };
  if (Number(now) >= graceEnd) return { offer: false, why: 'graceOver', graceEnd };
  return { offer: true, why: null, graceEnd };
}
