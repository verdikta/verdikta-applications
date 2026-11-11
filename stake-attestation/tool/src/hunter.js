// The library: one object with every verb. The CLI (cli.js) is a thin layer over it, and an autonomous hunter or an
// agent skill drives this directly. No wallet, key or secret is on the returned object: it holds functions only.
import { runAppeal } from './appeal.js';
import { runCheck } from './check.js';
import { runClaim, runFinalize, runSettle, runWithdraw } from './claim.js';
import { runCommit } from './commit.js';
import { fail } from './errors.js';
import { inspectListing } from './listing.js';
import { makeContext } from './context.js';
import { runReveal } from './reveal.js';
import { runStatus } from './status.js';

/**
 * @param {object} options
 * @param {import('ethers').Provider} [options.provider]
 * @param {import('ethers').Signer} [options.signer] - needed by commit, reveal, finalize, settle, withdraw, claim, appeal
 * @param {string} [options.contract] - the StakeAttestation address
 * @param {string} [options.gateway] - an IPFS gateway's base URL
 * @param {{ pin: (bytes: Buffer, o?: { name?: string }) => Promise<string> }} [options.pinner] - createPinner's
 * @param {{ url: string, token: string, allowRemote?: boolean }} [options.runner] - the code-runner, for check
 * @param {{ publicKey: string }[]} [options.devKeys] - builder dev keys to accept, for a statement that says dev
 * @param {number} [options.confirmations] - blocks a commit must have before the ciphertext is pinned (default 2)
 * @param {(step: string) => void|Promise<void>} [options.onStep] - each point of a long flow (steps.js), by name
 * @param {(text: string) => void} [options.onNotice] - what must be said before anyone pays: show it
 */
export function createHunter(options = {}) {
  const ctx = makeContext(options);
  return Object.freeze({
    /** @param {{ claimDir: string, listingId?: bigint, listingArchive?: Buffer }} o */
    check: (o) => runCheck(ctx, o),
    /** @param {{ claimDir: string, listingId?: bigint, acknowledge?: boolean, restart?: boolean, acceptUnreadPin?: boolean }} o */
    commit: (o) => runCommit(ctx, o),
    /**
     * reveal, or with `retrigger` a failed round's re-trigger: that pays the lens's retriggerTopUp, so it says the cost
     * through onNotice and sends only with `acknowledge`.
     * @param {{ claimDir: string, retrigger?: boolean, acknowledge?: boolean }} o
     */
    reveal: (o) => runReveal(ctx, o),
    /** @param {{ claimId?: bigint, claimDir?: string, wait?: boolean, maxWaitMs?: number }} o */
    status: (o) => runStatus(ctx, o),
    finalize: (claimId) => runFinalize(ctx, claimId),
    /**
     * Before the lens's settleableAt, the hunter's own settle of an INVALID waives the appeal (erratum E7): refused
     * with NEEDS_WAIVER unless `waiveAppeal`.
     * @param {bigint} claimId @param {{ waiveAppeal?: boolean }} [o]
     */
    settle: (claimId, o) => runSettle(ctx, claimId, o),
    withdraw: () => runWithdraw(ctx),
    /** @param {{ claimId?: bigint, claimDir?: string, waiveAppeal?: boolean }} o */
    claim: (o) => runClaim(ctx, o),
    /**
     * The hunter's appeal of an INVALID to the dispute panel (erratum E7), or its one re-trigger: pays the live
     * dispute fee, so it says the cost through onNotice and sends only with `acknowledge`.
     * @param {{ claimId?: bigint, claimDir?: string, acknowledge?: boolean }} o
     */
    appeal: (o) => runAppeal(ctx, o),
    readListing: async (listingId) => {
      await ctx.ensureChain();
      const listing = await inspectListing(ctx, listingId);
      if (listing.refusal) throw fail(listing.refusal, `Listing ${listingId}.`);
      const { listingBytes: _unused, ...rest } = listing;
      return rest;
    },
  });
}
