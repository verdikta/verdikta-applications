// What the tool says before anyone pays. P9's warning, word for word (shared/src/listingWarning.js), and the
// hunter-diligence text of design §8.6, with the two things owner decision Q35 wants stated plainly: what the
// forecast cannot catch, and what a failed integrity check costs. Design §12 adds what an abstention costs.
import { LISTING_WARNING } from '@verdikta/stake-attestation-shared/listing-warning';
import { formatEther } from 'ethers';

const eth = (wei) => `${formatEther(wei)} ETH`;

export const DILIGENCE = Object.freeze([
  'Read the scope, the known issues and the rubric before working.',
  'Run check before committing: nothing leaves this machine, and it is the only place some failures show.',
  'The prepay is spent whatever the verdict.',
  'The bond is forfeited on INVALID and returned on DUPLICATE.',
  'The award is for the committed hash, not for the fixed version.',
]);

export const DATE_TRAP = 'The forecast does not catch a trap keyed on the date: the runner fakes no clock, so what repository code or a vyper does on a later day may differ.';
export const INTEGRITY_COSTS = 'A tamper flag costs the bond, even beside another failed check. Any other failed integrity check returns the bond, with no award.';

/** Design §12: nothing of this reaches the chain or IPFS, so the words are all a hunter gets. */
export const ABSTAIN_COSTS = 'Each failed round costs you the base fees (K × the per-oracle fee, about $1.75 of the $3.50 standard prepay); the rest of the prepay comes back at finalize. If no round settles, the bond goes to the maker at expiry. Nothing on-chain or on IPFS says why.';
export const ABSTAIN_BY_CLAIM = `A run that ends this way decides nothing: every arbiter abstains the same way, with no commit and no verdict, unless its host differs. ${ABSTAIN_COSTS} So this check is the one place you can see it.`;
export const ABSTAIN_BY_HOST = `No forecast: this machine's runner could not finish the run, which says nothing of your claim. Fix it and run check again. On the arbiters, an abstain costs this: ${ABSTAIN_COSTS}`;

export const NO_PROOF_CHECK = 'This tool checks that the builder signed this listing. It does not check that the on-chain maker is the address the repository names: the site does that, and shows a listing that fails it apart.';

/** @param {object} t - the terms (listing.js termsForNotice) */
export function commitNotice(t) {
  const awards = t.awards.map((a, i) => `${['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][i]} ${eth(a)}`).join(', ');
  return [
    LISTING_WARNING.title,
    LISTING_WARNING.proofFirst,
    LISTING_WARNING.elsewhere,
    '',
    NO_PROOF_CHECK,
    '',
    'Before you commit',
    ...DILIGENCE.map((line) => `- ${line}`),
    `- ${DATE_TRAP}`,
    `- ${INTEGRITY_COSTS}`,
    `- A proof that loops, or runs out of memory or processes, makes every arbiter abstain. ${ABSTAIN_COSTS}`,
    '',
    `Listing ${t.listingId}: ${t.repo} at ${t.baseCommit}${t.invited ? ' (invited)' : ''}`,
    `Awards: ${awards}; lowest class counted: ${t.lowestClass}`,
    `This commit sends ${eth(t.priceWei)}: the bond ${eth(t.bondWei)} and the prepay ${eth(t.feeWei)}, the live maximum fee.`,
    `The fix window is ${t.fixWindow} s from your disclosure, the reveal window ${t.revealWindow} s, the dispute window ${t.disputeWindow} s.`,
  ].join('\n');
}

/** What every forecast ends with (owner decision Q35). */
export function forecastFooter() {
  return [DATE_TRAP, INTEGRITY_COSTS].join('\n');
}

export const REMOTE_RUNNER_NOTICE = 'This runner is not on this machine as far as the tool can tell, and it reads the plaintext of your claim: an unfixed finding, in the hands of whoever runs it.';

/**
 * What an appeal (erratum E7) or its one re-trigger costs and does, said before anything is sent.
 * @param {{ action: 'appeal'|'retrigger', claimId: bigint, valueWei: bigint, deadline: bigint, revealWindow: bigint }} a
 */
export function appealNotice(a) {
  const pays = `This sends ${eth(a.valueWei)} from this wallet: the live dispute fee the contract quotes now, all of it the prepay of one round of the listing's dispute panel. The prepay is spent whatever the result: you bear what the round spends, and the unspent part comes back to this wallet when the round is finalized. Nothing of it comes from the escrow or the bond.`;
  const verdict = 'The panel reads the claim as it was revealed, and its report.md is your argument. Its verdict is final: held, the INVALID stands and the bond goes to the maker, unless the panel\'s vector is a narrow INVALID, whose bond comes back; overturned, the panel\'s outcome settles at once, a counted class with its award.';
  if (a.action === 'retrigger') {
    return [
      `Re-trigger the appeal of claim ${a.claimId}: its round settled no verdict, and this is its one re-trigger.`,
      `${pays} The failed round's prepay was spent, so this one is a fresh fee in full.`,
      verdict,
      'If this round settles no verdict too, the INVALID stands, narrow or not by its own vector.',
      `Re-trigger before ${a.deadline} on the chain's clock.`,
    ].join('\n');
  }
  return [
    `Appeal claim ${a.claimId}'s INVALID to the dispute panel, once.`,
    pays,
    verdict,
    `If the round settles no verdict, you may re-trigger it once, for a fresh fee in full, until ${a.revealWindow} s after it ended: run appeal again.`,
    `Appeal before ${a.deadline} on the chain's clock.`,
  ].join('\n');
}

/**
 * A hunter who settles their own INVALID before anyone else may waives the appeal (erratum E7), or the appeal's one
 * re-trigger when its round settled no verdict.
 * @param {{ what: 'appeal'|'retrigger', until: bigint }} w
 */
export function waiverNotice({ what, until }) {
  const gives = what === 'retrigger' ? 'waives the appeal\'s re-trigger, the round your appeal has left' : 'waives the appeal';
  return `Settling your own INVALID now ${gives}: until ${until} on the chain's clock only you may settle it, and the INVALID then stands as it is. From then on anyone may settle it, and nothing is waived.`;
}
