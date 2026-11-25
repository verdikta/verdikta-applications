/**
 * Round keeper: moves the bounty rounds in flight along the v2 aggregator's steps, so a round never
 * waits on its hunter for anything but a result.
 *
 * A v2 round needs outside calls (verdikta-dispatcher MIGRATION.md): the jury is drawn by drawJury
 * from two blocks after the request (twice for a beacon round), the commit window may need
 * closeCommits after T+, promote is due from two blocks after it closes, a dead round is closed
 * (settled or cancelled), and a re-run that wasn't taken in its window is expired. Anyone may send
 * each of them. The escrow's lens says which one will succeed now (nextAction); this keeper sends
 * it, after simulating it:
 *
 *   DRAW          escrow.drawJury(bountyId, submissionId)  — through the submission's wallet, so the
 *                 draw reward goes back to the round's funder, not to this keeper
 *   CLOSE_COMMITS aggregator.closeCommits(aggId)
 *   PROMOTE       aggregator.promote(aggId)                — the caller earns 1 x fee (ethOwed)
 *   CLOSE_FAILED  escrow.closeFailedRound(bountyId, submissionId)
 *   EXPIRE_RERUN  escrow.expireRerun(bountyId, submissionId)
 *
 * FINALIZE is left to hunters and clients, as before. The keeper's own rewards (promote) are
 * withdrawn now and then (withdrawRewards). It needs a funded key (KEEPER_PRIVATE_KEY); without one
 * the server runs without it and every step stays available to anyone (the calldata endpoints).
 */

const { ethers } = require('ethers');
const defaultLogger = require('./logger');

const ACTIONS = Object.freeze({
  DRAW: { target: 'escrow', fn: 'drawJury', args: (b, s) => [b, s] },
  CLOSE_COMMITS: { target: 'aggregator', fn: 'closeCommits', args: (b, s, aggId) => [aggId] },
  PROMOTE: { target: 'aggregator', fn: 'promote', args: (b, s, aggId) => [aggId] },
  CLOSE_FAILED: { target: 'escrow', fn: 'closeFailedRound', args: (b, s) => [b, s] },
  EXPIRE_RERUN: { target: 'escrow', fn: 'expireRerun', args: (b, s) => [b, s] }
});

const GAS_MARGIN_PCT = 25n;
// A 50-juror draw uses ~13.5M, so estimate + 25% would pass the per-tx cap: the limit is clamped to it.
const { TX_GAS_CAP } = require('./gasLimits');
const IN_FLIGHT_MS = 90_000;            // don't resend the same step while its tx may still land
// A step that simulates but never moves the round (its tx reverts or no-ops on chain, which the keeper
// does not watch) would otherwise be resent every IN_FLIGHT_MS for as long as the round lives, each
// time at up to TX_GAS_CAP. Cap the sends per round and step (a beacon draw legitimately takes two);
// past it the step is left to anyone else (the calldata endpoints). Records expire after a day.
const MAX_SENDS_PER_STEP = 4;
const ATTEMPT_TTL_MS = 24 * 60 * 60_000;
const LOW_BALANCE_WEI = 2_000_000_000_000_000n;   // 0.002 ETH
const BALANCE_CHECK_MS = 10 * 60_000;
const WITHDRAW_EVERY_MS = 60 * 60_000;

class RoundKeeper {
  /**
   * @param {object} o
   * @param {object} o.contractService  ContractService (escrow contract, provider, getAggregator/getAggregatorAddress)
   * @param {object} o.signer           ethers Signer for the keeper key
   * @param {object} [o.logger]
   * @param {() => number} [o.now]      ms clock (tests)
   */
  constructor({ contractService, signer, logger = defaultLogger, now = Date.now }) {
    this.cs = contractService;
    this.signer = signer;
    this.logger = logger;
    this.now = now;
    this.inFlight = new Map();          // `${bountyId}:${submissionId}:${action}` -> { hash, at }
    this.attempts = new Map();          // `${bountyId}:${submissionId}:${aggId}:${action}` -> { count, first }
    this.lastBalanceCheck = 0;
    this.lastWithdraw = 0;
    this.sent = 0;
  }

  async address() {
    if (!this._address) this._address = await this.signer.getAddress();
    return this._address;
  }

  /**
   * Send the step `state.nextAction` calls for, if this keeper handles it and it simulates.
   * @param {number|string} bountyId on-chain bounty id
   * @param {number|string} submissionId
   * @param {object} state  getRoundState() output (nextAction), plus aggId for aggregator steps
   * @returns {Promise<{action: string|null, sent: boolean, hash?: string, reason?: string}>}
   */
  async tend(bountyId, submissionId, state) {
    const action = state && state.nextAction;
    const spec = ACTIONS[action];
    if (!spec) return { action: action || null, sent: false, reason: 'not_a_keeper_step' };
    const key = `${bountyId}:${submissionId}:${action}`;
    const prior = this.inFlight.get(key);
    if (prior && this.now() - prior.at < IN_FLIGHT_MS) return { action, sent: false, reason: 'in_flight', hash: prior.hash };
    const attemptKey = `${bountyId}:${submissionId}:${state.aggId || ''}:${action}`;
    const attempts = this.attempts.get(attemptKey);
    if (attempts && attempts.count >= MAX_SENDS_PER_STEP) return { action, sent: false, reason: 'send_cap_reached' };

    let contract;
    if (spec.target === 'escrow') {
      contract = this.cs.contract.connect(this.signer);
    } else {
      if (!state.aggId) return { action, sent: false, reason: 'no_agg_id' };
      contract = (await this.cs.getAggregator()).connect(this.signer);
    }
    const args = spec.args(bountyId, submissionId, state.aggId);
    const from = await this.address();
    let gasLimit;
    try {
      const gas = await contract[spec.fn].estimateGas(...args, { from });
      gasLimit = (BigInt(gas) * (100n + GAS_MARGIN_PCT)) / 100n;
      if (gasLimit > TX_GAS_CAP) gasLimit = TX_GAS_CAP;
    } catch (err) {
      // Some nodes' estimateGas fails for a call that needs most of the cap (a 50-juror draw:
      // try/catch inside makes the binary search ask for far more). Simulate at the cap itself.
      try {
        await contract[spec.fn].staticCall(...args, { from, gasLimit: TX_GAS_CAP });
        gasLimit = TX_GAS_CAP;
      } catch {
        // The step won't succeed right now (another caller got there first, or the round moved on).
        this.logger.debug('[keeper] simulation refused', { bountyId, submissionId, action, reason: err.shortMessage || err.message });
        return { action, sent: false, reason: 'simulation_failed' };
      }
    }
    try {
      const tx = await contract[spec.fn](...args, { gasLimit });
      this.inFlight.set(key, { hash: tx.hash, at: this.now() });
      this.attempts.set(attemptKey, { count: (attempts ? attempts.count : 0) + 1, first: attempts ? attempts.first : this.now() });
      if (attempts && attempts.count + 1 >= MAX_SENDS_PER_STEP) {
        this.logger.warn('[keeper] step sent the maximum number of times without the round moving on; leaving it to others',
          { bountyId, submissionId, action, sends: attempts.count + 1 });
      }
      this.sent++;
      this.logger.info('[keeper] sent', { bountyId, submissionId, action, hash: tx.hash });
      return { action, sent: true, hash: tx.hash };
    } catch (err) {
      this.logger.warn('[keeper] send failed', { bountyId, submissionId, action, error: err.shortMessage || err.message });
      return { action, sent: false, reason: 'send_failed' };
    }
  }

  /** Forget in-flight records older than the window (so a dropped tx is retried). */
  prune() {
    const cutoff = this.now() - IN_FLIGHT_MS;
    for (const [k, v] of this.inFlight) if (v.at < cutoff) this.inFlight.delete(k);
    const attemptCutoff = this.now() - ATTEMPT_TTL_MS;
    for (const [k, v] of this.attempts) if (v.first < attemptCutoff) this.attempts.delete(k);
  }

  /**
   * Housekeeping: warn on a low gas balance, and now and then withdraw the keeper's rewards
   * (promote) from the escrow's aggregator. Never throws.
   */
  async housekeeping() {
    const now = this.now();
    try {
      if (now - this.lastBalanceCheck >= BALANCE_CHECK_MS) {
        this.lastBalanceCheck = now;
        const bal = await this.cs.provider.getBalance(await this.address());
        if (bal < LOW_BALANCE_WEI) {
          this.logger.warn('[keeper] low gas balance: fund the keeper key, or rounds wait for anyone else to move them',
            { address: await this.address(), balanceEth: ethers.formatEther(bal) });
        }
      }
      if (now - this.lastWithdraw >= WITHDRAW_EVERY_MS) {
        this.lastWithdraw = now;
        await this.withdrawRewards();
      }
    } catch (err) {
      this.logger.warn('[keeper] housekeeping failed', { error: err.message });
    }
  }

  /** Withdraw this keeper's ethOwed from the escrow's aggregator, if it owes anything. */
  async withdrawRewards() {
    const me = await this.address();
    const out = [];
    const addr = await this.cs.getAggregatorAddress();
    const agg = this.cs.getAggregatorAt(addr);
    const owed = await agg.ethOwed(me);
    if (owed > 0n) {
      const tx = await agg.connect(this.signer).withdrawEth();
      this.logger.info('[keeper] withdrew rewards', { aggregator: addr, amountEth: ethers.formatEther(owed), hash: tx.hash });
      out.push({ aggregator: addr, amount: owed.toString(), hash: tx.hash });
    }
    return out;
  }
}

/** A keeper for `privateKey` on the contract service's provider, or null when no key is set. */
function createRoundKeeper(contractService, privateKey, opts = {}) {
  if (!privateKey) return null;
  const signer = new ethers.Wallet(privateKey, contractService.provider);
  return new RoundKeeper({ contractService, signer, ...opts });
}

module.exports = { RoundKeeper, createRoundKeeper, ACTIONS, IN_FLIGHT_MS, MAX_SENDS_PER_STEP };
