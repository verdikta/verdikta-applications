// What the tool says before anyone pays. P9's warning, word for word (shared/src/listingWarning.js), and the
// hunter-diligence text of design §8.6, with the two things owner decision Q35 wants stated plainly: what the
// forecast cannot catch, and what a failed integrity check costs. Design §12 adds what an abstention costs.
import { DISCLOSURE_KEY_NOTE } from '@verdikta/stake-attestation-shared/disclosure-key';
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

/**
 * A late claim's three warnings (node P43; design §13.2, decision D6), said before one is paid for, each as the
 * contract has it: ClaimLogic.settle pays a late claim no award at any class and counts it under the record's `later`;
 * an INVALID's bond goes to the maker unless the INVALID is narrow (erratum E8), late or not, and every other outcome
 * returns it; the prepay goes to the round, and the round's wallet returns what it did not spend at finalize, in a
 * call that is caught: when it fails the refund is deferred (RefundDeferred), and recoverLeftoverEth, which anyone may
 * call, pays it to the hunter.
 * agents.txt says the three word for word (client/test/agentDocs.test.js).
 */
export const LATE_CLAIM_WARNINGS = Object.freeze([
  'A late claim pays no award, whatever class the arbiters give it: it is judged and recorded on the record, under "later".',
  'The bond is forfeited on INVALID, as on any claim: it goes to the maker, unless the INVALID is narrow. On any other outcome it comes back, with no award.',
  'The prepay is spent on the evaluation whatever the verdict: what a round does not spend comes back when the round is finalized or, if the refund fails then, when anyone calls recoverLeftoverEth on the wallet of that round.',
]);

/** What commit, status and claim say of a claim that is a late one (getClaim's `late`). */
export const LATE_CLAIM_NOTE = 'A late claim: it is judged and recorded on the record under "later", and pays no award. When it settles, its bond comes back unless the outcome is INVALID (a narrow INVALID\'s comes back too).';

/**
 * What a run says when the claim its folder holds is not the kind its flag asked for (node P43). --late is read only
 * until a commit or a late claim is signed: from then on the folder holds that one, and a later run goes on with it,
 * since the bond is paid and only a disclosure in time keeps it.
 * @param {{ claimId: bigint|string, late: boolean }} c the claim, with the chain's `late`
 */
export function kindNotice({ claimId, late }) {
  if (late) return `Claim ${claimId} in this folder is a late claim: this run goes on with it as that, and it pays no award.`;
  return `Claim ${claimId} in this folder is an ordinary commit, made before this run: --late changes nothing now, and this run goes on with it.`;
}

/**
 * The live price read as a commit or a late claim is signed, when it is not the one this run's terms named: the
 * aggregator's fee moved in between. Said before the signature, so the amount printed is the amount sent.
 * @param {{ late: boolean, quoted: bigint, price: bigint }} p
 */
export function priceMovedNotice({ late, quoted, price }) {
  return `The live fee moved since the terms above were said: this ${late ? 'late claim' : 'commit'} sends ${eth(price)} now, not ${eth(quoted)}.`;
}

/**
 * How report.md is written (owner, 2026-11-10). Q73 #4: the claim query classes a finding by the consequence the PoC
 * demonstrates, or that follows from it by reasoning the claim sets out; this sentence is the owner's, word for word.
 * Q73 #2: the report says where the code is required to behave as the PoC asserts, and says so when nothing states it.
 * No gate reads the section: check and commit warn without it (report.js), and refuse nothing.
 */
export const CONSEQUENCE = 'Make the PoC demonstrate the consequence you claim; the jury classes by what it shows.';
export const REQUIREMENT = 'In report.md, a section headed "## Requirement" says where the code is required to behave as your PoC asserts: a file and line, or a listing document. If nothing in the code or the listing states it, say so there.';

export const DATE_TRAP = 'The forecast does not catch a trap keyed on the date: the runner fakes no clock, so what repository code or a vyper does on a later day may differ.';
export const INTEGRITY_COSTS = 'A tamper flag costs the bond, even beside another failed check. Any other failed integrity check returns the bond, with no award.';

/**
 * Design §12: nothing of this reaches the chain or IPFS, so the words are all a hunter gets. No amount is fixed here
 * (node P32): the fee follows the aggregator's, so status reads a failed round's own numbers from the chain.
 */
export const ABSTAIN_COSTS = 'Each failed round costs you its base fees (K × the per-oracle fee), a part of its prepay; the rest of the prepay comes back at finalize, and status shows the round\'s own numbers, in ETH. If no round settles, the bond goes to the maker at expiry. Nothing on-chain or on IPFS says why.';

/**
 * What a round that ends with no verdict means (node P32): too few arbiters' answers in the aggregator's time, which is
 * its responseTimeoutSeconds, read from the chain when `timeoutSeconds` is given.
 * @param {bigint|null} [timeoutSeconds]
 */
export function noVerdictMeans(timeoutSeconds = null) {
  const time = timeoutSeconds ? `its response timeout, ${timeoutSeconds} s now` : 'its response timeout';
  return `A round ends with no verdict when too few arbiters commit and reveal a result within the aggregator's time for it (${time}): most often every arbiter abstained on this claim, from a proof that loops or runs out of time, memory or processes, or a build the runner could not finish; or the arbiters were down.`;
}

/** Why a re-trigger of the same claim is likely to fail as the last round did (node P32). */
export const RETRIGGER_SAME_CLAIM = 'A re-trigger sends the same committed claim to the same arbiters, so unless the cause was on their side it is likely to fail the same way: run check on this claim first, and re-trigger only once it does not abstain there.';
export const ABSTAIN_BY_CLAIM = `A run that ends this way decides nothing: every arbiter abstains the same way, with no commit and no verdict, unless its host differs. ${ABSTAIN_COSTS} So this check is the one place you can see it.`;
export const ABSTAIN_BY_HOST = `No forecast: this machine's runner could not finish the run, which says nothing of your claim. Fix it and run check again. On the arbiters, an abstain costs this: ${ABSTAIN_COSTS}`;

/**
 * Claims on a listing reveal in commit order (decision D5; ClaimLogic.revealDeadline): said before anyone pays, with the
 * listing's own count. A listing that takes commits holds no late claim, so its pendingClaims are the claims ahead.
 * A late claim (node P43) joins the same queue on a listing that may hold other late claims, which pendingClaims never
 * counts: `lateOpenClaims` (listing.js) is how many of those are neither settled nor expired, and the count is both.
 * @param {{ pendingClaims?: bigint, headClaim?: bigint, late?: boolean, lateOpenClaims?: bigint }} t
 */
export function queueNotice(t) {
  if (t.pendingClaims === undefined || t.pendingClaims === null) return null;
  const lateOpen = t.late ? BigInt(t.lateOpenClaims ?? 0n) : 0n;
  const open = BigInt(t.pendingClaims) + lateOpen;
  if (open === 0n) return `No other claim on this listing is open now, so a ${t.late ? 'late claim' : 'commit'} sent now would be first in commit order.`;
  const among = lateOpen === 0n ? '' : ` (${lateOpen} of them ${lateOpen === 1n ? 'a late claim' : 'late claims'})`;
  return `Open claims on this listing now: ${open}, the earliest claim ${t.headClaim}${among}. Claims reveal in commit order: yours can be revealed only once every claim committed before it is settled or expired, whatever its own fix window says and even if the maker releases it.`;
}

/**
 * What an admission refusal for memory is on a hunter's machine, said under every admission refusal: the runner's own
 * detail, printed above it, says which refusal it is and names the figures (it also refuses for a busy slot, a full
 * disk or a shutdown), and no words of the runner's are matched to decide. The memory a run may use is the class's
 * hard limit (@verdikta/common CLASS_HARD_LIMITS), which no setting lowers; a claim with a fix.patch opens two
 * sandboxes at once (code-runner src/claim.js, sandboxesFor).
 */
export const ADMISSION_HINT = 'When the runner refuses for memory, as its detail says: a run\'s sandbox may use up to the class\'s memory limit, which no setting lowers, twice over for a claim with a fix.patch, and the runner holds more back for an arbiter\'s other services. Give the machine Docker runs in more memory, check the claim without its fix.patch, or lower that reserve in the runner\'s settings on a machine that runs no arbiter.';

export const NO_PROOF_CHECK = 'This tool checks that the builder signed this listing. It does not check that the on-chain maker is the address the repository names: the site does that, and shows a listing that fails it apart.';

/**
 * What `commit --late` says before a late claim is paid for (node P43): the listing's warning and the diligence that
 * hold for any claim, the three warnings in place of what a commit says of its award, and the terms that apply. The
 * listing's award table and its allowlist do not: a late claim pays no award and is open to every hunter.
 * @param {object} t - the terms (listing.js termsForNotice, with `late`)
 */
function lateClaimNotice(t) {
  const [readFirst, runCheck] = DILIGENCE;
  const rolledTo = t.state === 'Rolled' && t.successor ? `: its stake rolled forward to listing ${t.successor}` : '';
  return [
    LISTING_WARNING.title,
    LISTING_WARNING.proofFirst,
    LISTING_WARNING.elsewhere,
    '',
    NO_PROOF_CHECK,
    '',
    'A late claim, not a commit: this listing takes no commit any more',
    ...LATE_CLAIM_WARNINGS.map((line) => `- ${line}`),
    '',
    'Before you commit',
    `- ${readFirst}`,
    `- ${runCheck}`,
    `- ${CONSEQUENCE}`,
    `- ${REQUIREMENT}`,
    `- ${DATE_TRAP}`,
    `- ${INTEGRITY_COSTS}`,
    `- A proof that loops, or runs out of memory or processes, makes every arbiter abstain. ${ABSTAIN_COSTS}`,
    '',
    `Listing ${t.listingId} (${t.state}${rolledTo}): ${t.repo} at ${t.baseCommit}`,
    ...(t.invited ? ['The listing is invited, which holds for its commits only: a late claim is open to every hunter.'] : []),
    `This late claim sends ${eth(t.priceWei)}: the bond ${eth(t.bondWei)} and the prepay ${eth(t.feeWei)}, the live maximum fee.`,
    `The fix window is ${t.fixWindow} s from your disclosure, the reveal window ${t.revealWindow} s, the dispute window ${t.disputeWindow} s.`,
    ...(queueNotice(t) ? [queueNotice(t)] : []),
    ...(t.disclosureRecipient ? [`Disclosure key: ${t.disclosureRecipient}, on-chain the bytes32 ${t.disclosureKey}. ${DISCLOSURE_KEY_NOTE}`] : []),
  ].join('\n');
}

/** @param {object} t - the terms (listing.js termsForNotice); with `late`, a late claim's (node P43) */
export function commitNotice(t) {
  if (t.late) return lateClaimNotice(t);
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
    `- ${CONSEQUENCE}`,
    `- ${REQUIREMENT}`,
    `- ${DATE_TRAP}`,
    `- ${INTEGRITY_COSTS}`,
    `- A proof that loops, or runs out of memory or processes, makes every arbiter abstain. ${ABSTAIN_COSTS}`,
    '',
    `Listing ${t.listingId}: ${t.repo} at ${t.baseCommit}${t.invited ? ' (invited)' : ''}`,
    `Awards: ${awards}; lowest class counted: ${t.lowestClass}`,
    `This commit sends ${eth(t.priceWei)}: the bond ${eth(t.bondWei)} and the prepay ${eth(t.feeWei)}, the live maximum fee.`,
    `The fix window is ${t.fixWindow} s from your disclosure, the reveal window ${t.revealWindow} s, the dispute window ${t.disputeWindow} s.`,
    ...(queueNotice(t) ? [queueNotice(t)] : []),
    // node P35: the key in both its forms, the archive's and the chain's, and that they are one key
    ...(t.disclosureRecipient ? [`Disclosure key: ${t.disclosureRecipient}, on-chain the bytes32 ${t.disclosureKey}. ${DISCLOSURE_KEY_NOTE}`] : []),
  ].join('\n');
}

/** What every forecast ends with (owner decision Q35). */
export function forecastFooter() {
  return [DATE_TRAP, INTEGRITY_COSTS].join('\n');
}

export const REMOTE_RUNNER_NOTICE = 'This runner is not on this machine as far as the tool can tell, and it reads the plaintext of your claim: an unfixed finding, in the hands of whoever runs it.';

/**
 * What an appeal (erratum E7) or its one re-trigger costs and does, said before anything is sent. On a late claim
 * (`late`, node P43) an overturned INVALID returns the bond and pays nothing more: no class of a late claim has an award.
 * @param {{ action: 'appeal'|'retrigger', claimId: bigint, valueWei: bigint, deadline: bigint, revealWindow: bigint, late?: boolean }} a
 */
export function appealNotice(a) {
  const pays = `This sends ${eth(a.valueWei)} from this wallet: the live dispute fee the contract quotes now, all of it the prepay of one round of the listing's dispute panel. The prepay is spent whatever the result: you bear what the round spends, and the unspent part comes back to this wallet when the round is finalized. Nothing of it comes from the escrow or the bond.`;
  const overturned = a.late
    ? 'overturned, the panel\'s outcome settles at once and the bond comes back, with nothing more: a late claim pays no award, whatever the class.'
    : 'overturned, the panel\'s outcome settles at once, a counted class with its award.';
  const verdict = `The panel reads the claim as it was revealed, and its report.md is your argument. Its verdict is final: held, the INVALID stands and the bond goes to the maker, unless the panel's vector is a narrow INVALID, whose bond comes back; ${overturned}`;
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
 * What a claim round's re-trigger (design §12, erratum E6) costs and does, said before anything is sent. The value is
 * the lens's retriggerTopUp: the live maximum fee less what a refused submission left held, so after a round that ran
 * it is a fresh prepay in full.
 * @param {{ claimId: bigint, valueWei: bigint, deadline: bigint }} r
 */
export function retriggerNotice({ claimId, valueWei, deadline }) {
  return [
    `Re-trigger claim ${claimId}'s failed round: the request its reveal sent goes to the arbiters again, as a new round.`,
    `This sends ${eth(valueWei)} from this wallet: the top-up the contract quotes now, the live maximum fee less any prepay a refused submission left held. A round that ran took its prepay, so after one this is a fresh prepay in full.`,
    `If this round fails too: ${ABSTAIN_COSTS}`,
    `Re-trigger before ${deadline} on the chain's clock: a round that fails again does not move that time.`,
  ].join('\n');
}

/**
 * What a reveal sends and does, said before anything is pinned or sent (node P32): without `acknowledge` (--yes) it is
 * a dry run, as a re-trigger is. The top-up is the lens's revealTopUp, read again just before the reveal is signed.
 * @param {{ claimId: bigint, valueWei: bigint, deadline: bigint }} r
 */
export function revealNotice({ claimId, valueWei, deadline }) {
  return [
    `Reveal claim ${claimId}: this pins the plaintext archive, your proof and report, which is public from then on, and sends the reveal with its keys.`,
    `It sends ${eth(valueWei)} from this wallet now: the top-up the contract quotes (revealTopUp), the rise in the live fee since your commit, 0 when the prepay covers it, read again as it is signed. Gas is on top.`,
    'The arbiters then run the round; status --wait follows it.',
    `Reveal before ${deadline} on the chain's clock: unrevealed by then, anyone may expire the claim, and the bond goes to the maker.`,
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
