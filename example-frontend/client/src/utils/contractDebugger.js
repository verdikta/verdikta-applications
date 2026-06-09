// Browser-based contract debugging utility for the ETH-funded ReputationAggregator.
// Fired on-demand from RunQuery when a request errors. Arbiters are paid in ETH, so the
// diagnostics check the requester's ETH balance vs. the worst-case prepay and dry-run the
// payable request — there is no LINK allowance/balance to inspect anymore.

import { ethers } from 'ethers';

const CONTRACT_ABI = [
  "function getContractConfig() view returns (address oracleAddr, address linkAddr, bytes32 jobId, uint256 currentFee)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxTotalFee(uint256 maxFee) view returns (uint256)",
  "function maxOracleFee() view returns (uint256)",
  "function ethOwed(address) view returns (uint256)",
  "function requestAIEvaluationWithApproval(string[] memory cidArray, string memory textAddendum, uint256 alpha, uint256 maxFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 class) payable returns (bytes32)"
];

export class ContractDebugger {
  constructor(provider, contractAddress, walletAddress) {
    this.provider = provider;
    this.contractAddress = contractAddress;
    this.walletAddress = walletAddress;
    this.contract = new ethers.Contract(contractAddress, CONTRACT_ABI, provider);
  }

  async debugContractState(contractClass) {
    const debug = {
      timestamp: new Date().toISOString(),
      contract: this.contractAddress,
      wallet: this.walletAddress,
      class: contractClass,
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

      // 2. Contract configuration (legacy view; linkAddr is informational only now)
      console.log('📋 Checking contract configuration...');
      try {
        const config = await this.contract.getContractConfig();
        debug.checks.config = {
          success: true,
          oracleAddr: config.oracleAddr,
          linkAddr: config.linkAddr,
          jobId: config.jobId,
          currentFee: ethers.formatUnits(config.currentFee, 18)
        };
      } catch (err) {
        debug.checks.config = { success: false, error: err.message };
      }

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
        const testMaxFee = ethers.parseUnits("0.0001", 18); // typical arbiter fee (ETH)
        const [totalFee, ceiling] = await Promise.all([
          this.contract.maxTotalFee(testMaxFee),
          this.contract.maxOracleFee().catch(() => null)
        ]);

        const creditWei = debug.checks.eth?._creditWei ?? 0n;
        const balanceWei = debug.checks.eth?._userBalanceWei ?? 0n;
        const valueNeeded = totalFee > creditWei ? totalFee - creditWei : 0n;

        debug.checks.fees = {
          success: true,
          maxFeeInput: ethers.formatUnits(testMaxFee, 18),
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

  async dryRunTransaction(cidArray, textAddendum, alpha, maxFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass) {
    try {
      console.log('🧪 Performing dry run...');

      // Size msg.value the same way the live request does: worst case minus existing credit.
      let value = 0n;
      try {
        const [total, credit] = await Promise.all([
          this.contract.maxTotalFee(maxFee),
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
        estimatedBaseCost,
        maxFeeBasedScalingFactor,
        contractClass,
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

  async generateDebugReport(cidArray, textAddendum, alpha, maxFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass) {
    console.log('🔍 Generating comprehensive debug report...');

    const report = {
      timestamp: new Date().toISOString(),
      parameters: {
        cidArray,
        textAddendum,
        alpha,
        maxFee: ethers.formatUnits(maxFee, 18),
        estimatedBaseCost: ethers.formatUnits(estimatedBaseCost, 18),
        maxFeeBasedScalingFactor,
        contractClass
      }
    };

    // Run all debugging checks
    report.stateAnalysis = await this.debugContractState(contractClass);
    report.dryRun = await this.dryRunTransaction(cidArray, textAddendum, alpha, maxFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass);

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
        solution: `Dry run reverted: ${report.dryRun.revertReason}. Common causes: no active arbiters for the selected class, or the per-oracle fee ceiling excluded them.`
      });
    }

    return recommendations;
  }
}

// Usage example:
// const dbg = new ContractDebugger(provider, contractAddress, walletAddress);
// const report = await dbg.generateDebugReport(cidArray, textAddendum, alpha, maxFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass);
