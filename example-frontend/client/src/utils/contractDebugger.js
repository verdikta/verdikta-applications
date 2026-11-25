// Browser-based contract debugging utility for the v2 ETH-funded ReputationAggregator.
// Fired on-demand from RunQuery when a request errors. Arbiters are paid in ETH, so the
// diagnostics check the requester's ETH balance vs. the worst-case prepay
// (maxTotalFee(maxFee, minFee, withBeacons, K, P)) and dry-run the 10-argument payable
// request, whose last argument is the jury; there is no LINK allowance/balance to inspect.

import { ethers } from 'ethers';
import { CONTRACT_ABI } from './contractUtils';
import { DEFAULT_JURY_PRESET_KEY, juryPresetByKey, juryShapeError } from './juryPresets';

const DEFAULT_JURY = juryPresetByKey(DEFAULT_JURY_PRESET_KEY).jury;

const juryArg = (j) => ({ K: j.K, M: j.M, N: j.N, P: j.P, timeout: j.timeout });

export class ContractDebugger {
  constructor(provider, contractAddress, walletAddress) {
    this.provider = provider;
    this.contractAddress = contractAddress;
    this.walletAddress = walletAddress;
    this.contract = new ethers.Contract(contractAddress, CONTRACT_ABI, provider);
  }

  async debugContractState(contractClass, maxFee = ethers.parseUnits('0.0001', 18), minFee = 0n, withBeacons = false, jury = DEFAULT_JURY) {
    const debug = {
      timestamp: new Date().toISOString(),
      contract: this.contractAddress,
      wallet: this.walletAddress,
      class: contractClass,
      jury,
      checks: {}
    };

    try {
      console.group('🔍 Contract Debug Analysis');

      // 1. Contract presence
      const code = await this.provider.getCode(this.contractAddress);
      debug.checks.contract = { success: code !== '0x', codeExists: code !== '0x' };
      if (code === '0x') {
        console.error('❌ No contract code at address (wrong network or address?)');
      }

      // 2. The owner's bounds on a request's jury (v2 has no K()..P() or round timeout of its
      //    own: the jury is the request's) and the fee ceiling
      console.log('📋 Checking aggregator limits...');
      try {
        const [maxJury, maxTimeout, tPlus, ceiling] = await Promise.all([
          this.contract.maxJury(),
          this.contract.maxTimeout(),
          this.contract.tPlus(),
          this.contract.maxOracleFee()
        ]);
        debug.checks.config = {
          success: true,
          maxJury: Number(maxJury),
          maxTimeout: Number(maxTimeout),
          commitWindowSeconds: Number(tPlus),
          maxOracleFee: ethers.formatEther(ceiling)
        };
      } catch (err) {
        // A v1 aggregator (or a v2 one from before the per-request jury) lacks these getters.
        debug.checks.config = { success: false, error: err.message };
      }

      // 2b. The request's jury against the rules and those limits (the keeper's shortlist,
      //     60 by default, is checked on-chain too)
      const shape = juryShapeError(jury);
      const cfg = debug.checks.config;
      const limit = !cfg.success ? null
        : jury.K > cfg.maxJury ? `K ${jury.K} is above maxJury ${cfg.maxJury}`
        : jury.timeout <= cfg.commitWindowSeconds ? `timeout ${jury.timeout} s is not above tPlus ${cfg.commitWindowSeconds} s`
        : jury.timeout > cfg.maxTimeout ? `timeout ${jury.timeout} s is above maxTimeout ${cfg.maxTimeout} s`
        : jury.timeout > 86400 ? `timeout ${jury.timeout} s is above the one-day cap (86400 s, AggregatorLib.MAX_TIMEOUT)`
        : null;
      debug.checks.jury = { success: !shape && !limit, ...jury, ...(shape || limit ? { error: shape || limit } : {}) };

      // 3. Requester ETH balance + on-chain prepay credit
      console.log('💰 Checking ETH balance & prepay credit...');
      try {
        const [ethBalance, credit] = await Promise.all([
          this.provider.getBalance(this.walletAddress),
          this.contract.ethOwed(this.walletAddress).catch(() => 0n)
        ]);
        debug.checks.eth = {
          success: true,
          userBalance: ethers.formatEther(ethBalance),
          prepayCredit: ethers.formatEther(credit),
          _userBalanceWei: ethBalance,
          _creditWei: credit
        };
      } catch (err) {
        debug.checks.eth = { success: false, error: err.message };
      }

      // 4. Fee ceiling + worst-case prepay vs. wallet ETH
      console.log('💸 Checking fee calculation...');
      try {
        const [totalFee, ceiling] = await Promise.all([
          this.contract.maxTotalFee(maxFee, minFee, withBeacons, jury.K, jury.P),
          this.contract.maxOracleFee().catch(() => null)
        ]);

        const creditWei = debug.checks.eth?._creditWei ?? 0n;
        const balanceWei = debug.checks.eth?._userBalanceWei ?? 0n;
        const valueNeeded = totalFee > creditWei ? totalFee - creditWei : 0n;

        debug.checks.fees = {
          success: true,
          maxFeeInput: ethers.formatUnits(maxFee, 18),
          minFeeInput: ethers.formatUnits(minFee, 18),
          withBeacons,
          maxOracleFeeCeiling: ceiling != null ? ethers.formatEther(ceiling) : 'unknown',
          worstCasePrepay: ethers.formatEther(totalFee),
          ethToAttach: ethers.formatEther(valueNeeded),
          balanceSufficient: balanceWei >= valueNeeded
        };

        if (balanceWei < valueNeeded) {
          debug.checks.fees.shortfall = ethers.formatEther(valueNeeded - balanceWei);
          console.error(`❌ INSUFFICIENT ETH: need ${ethers.formatEther(valueNeeded)} ETH, have ${ethers.formatEther(balanceWei)} ETH`);
        }
      } catch (err) {
        debug.checks.fees = { success: false, error: err.message };
      }

      console.groupEnd();
      return debug;
    } catch (err) {
      debug.error = err.message;
      console.error('❌ Debug analysis failed:', err);
      return debug;
    }
  }

  async dryRunTransaction(cidArray, textAddendum, alpha, maxFee, minFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass, withBeacons, jury = DEFAULT_JURY) {
    try {
      console.log('🧪 Performing dry run...');

      // Size msg.value the same way the live request does: worst case minus existing credit.
      let value = 0n;
      try {
        const [total, credit] = await Promise.all([
          this.contract.maxTotalFee(maxFee, minFee, withBeacons, jury.K, jury.P),
          this.contract.ethOwed(this.walletAddress).catch(() => 0n)
        ]);
        value = total > credit ? total - credit : 0n;
      } catch (e) {
        console.warn('Could not size dry-run value; using 0:', e?.message || e);
      }

      // Use staticCall to simulate the payable transaction without executing
      await this.contract.requestAIEvaluationWithApproval.staticCall(
        cidArray,
        textAddendum,
        alpha,
        maxFee,
        minFee,
        estimatedBaseCost,
        maxFeeBasedScalingFactor,
        contractClass,
        withBeacons,
        juryArg(jury),
        { value, from: this.walletAddress }
      );

      console.log('✅ Dry run successful - transaction should work');
      return { success: true };

    } catch (err) {
      console.error('❌ Dry run failed:', err.message);

      let revertReason = 'Unknown';

      // Try to extract revert reason
      if (err.data) {
        // Try custom error decoding first
        try {
          const parsed = this.contract.interface.parseError(err.data);
          if (parsed) {
            const args = parsed.args.length ? `(${parsed.args.join(', ')})` : '';
            revertReason = parsed.name + args;
          }
        } catch {}

        if (revertReason === 'Unknown') {
          try {
            if (err.data.includes('4e487b71')) {
              revertReason = 'Panic error (assertion failure)';
            } else if (err.data.includes('08c379a0')) {
              revertReason = 'Revert with string message';
            }
          } catch (decodeErr) {
            // Ignore decode errors
          }
        }
      }

      // Fall back to reason/shortMessage from ethers
      if (revertReason === 'Unknown' && (err.reason || err.shortMessage)) {
        revertReason = err.reason || err.shortMessage;
      }

      return {
        success: false,
        error: err.message,
        revertReason,
        data: err.data
      };
    }
  }

  async generateDebugReport(cidArray, textAddendum, alpha, maxFee, minFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass, withBeacons, jury = DEFAULT_JURY) {
    console.log('🔍 Generating comprehensive debug report...');

    const report = {
      timestamp: new Date().toISOString(),
      parameters: {
        cidArray,
        textAddendum,
        alpha,
        maxFee: ethers.formatUnits(maxFee, 18),
        minFee: ethers.formatUnits(minFee, 18),
        estimatedBaseCost: ethers.formatUnits(estimatedBaseCost, 18),
        maxFeeBasedScalingFactor,
        contractClass,
        withBeacons,
        jury
      }
    };

    // Run all debugging checks
    report.stateAnalysis = await this.debugContractState(contractClass, maxFee, minFee, withBeacons, jury);
    report.dryRun = await this.dryRunTransaction(cidArray, textAddendum, alpha, maxFee, minFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass, withBeacons, jury);

    // Generate recommendations
    report.recommendations = this.generateRecommendations(report);

    console.log('📋 Debug Report:', report);
    return report;
  }

  generateRecommendations(report) {
    const recommendations = [];

    // Wrong network / no contract at address
    if (report.stateAnalysis.checks.contract && !report.stateAnalysis.checks.contract.success) {
      recommendations.push({
        priority: 'CRITICAL',
        issue: 'No contract at this address',
        solution: 'The selected aggregator address has no code on this network. Pick the address that matches the selected network.'
      });
    }

    // Not a v2 aggregator (a v1 address, or another contract)
    if (report.stateAnalysis.checks.contract?.success && report.stateAnalysis.checks.config && !report.stateAnalysis.checks.config.success) {
      recommendations.push({
        priority: 'CRITICAL',
        issue: 'Not a v2 aggregator',
        solution: 'The address does not answer the v2 aggregator getters (maxJury(), maxTimeout(), tPlus(), ...). It may be a v1 aggregator: select the v2 aggregator address for this network.'
      });
    }

    // The request's jury breaks a rule or a limit: the request would revert BadJury
    if (report.stateAnalysis.checks.jury && !report.stateAnalysis.checks.jury.success) {
      recommendations.push({
        priority: 'CRITICAL',
        issue: 'Jury refused (BadJury)',
        solution: `The request's jury would be refused: ${report.stateAnalysis.checks.jury.error}. Pick another jury size on the Jury Selection page.`
      });
    }

    // Insufficient ETH to cover the worst-case prepay
    if (report.stateAnalysis.checks.fees?.success && !report.stateAnalysis.checks.fees?.balanceSufficient) {
      recommendations.push({
        priority: 'HIGH',
        issue: 'Insufficient ETH for prepay',
        solution: `This query needs ${report.stateAnalysis.checks.fees.ethToAttach} ETH attached (plus gas). Add ETH to your wallet and retry.`
      });
    }

    // The dry run reverted — surface the decoded reason.
    if (!report.dryRun.success) {
      recommendations.push({
        priority: 'CRITICAL',
        issue: 'Transaction will revert',
        solution: `Dry run reverted: ${report.dryRun.revertReason}. Common causes: BadJury (the jury breaks K >= M >= N >= P >= 1, N <= 40, P >= 2 unless N = 1, K <= maxJury and the keeper's shortlist, or tPlus < timeout <= maxTimeout and <= 1 day), BadInput (estimatedBaseCost not below the clamped fee ceiling, alpha above 1000, or scaling outside 1..65535), InsufficientPayment (value plus credit below maxTotalFee), or a beacon request on an aggregator without a beacon contract. In v2 the request does not draw the jury, so an empty arbiter pool shows up at drawJury(), not here.`
      });
    }

    return recommendations;
  }
}

// Usage example:
// const dbg = new ContractDebugger(provider, contractAddress, walletAddress);
// const report = await dbg.generateDebugReport(cidArray, textAddendum, alpha, maxFee, minFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass, withBeacons, { K: 6, M: 5, N: 4, P: 3, timeout: 300 });
