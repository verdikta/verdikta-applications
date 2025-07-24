// Browser-based contract debugging utility
// Add this to the RunQuery component for advanced debugging

import { ethers } from 'ethers';

const CONTRACT_ABI = [
  "function getContractConfig() view returns (tuple(address linkAddr, uint256 fee, uint256 baseFee, uint256 requestTimeoutSeconds))",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxTotalFee(uint256 maxFee) view returns (uint256)",
  "function getRegisteredOracles(uint256 class) view returns (address[])",
  "function getOracleInfo(address oracle) view returns (tuple(string jobId, bool isActive, uint256 class, address node))",
  "function requestAIEvaluationWithApproval(string[] memory cidArray, string memory textAddendum, uint256 alpha, uint256 maxFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint256 class) payable returns (bytes32)"
];

const LINK_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)"
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
      
      // 1. Contract Configuration
      console.log('📋 Checking contract configuration...');
      try {
        const config = await this.contract.getContractConfig();
        debug.checks.config = {
          success: true,
          linkAddr: config.linkAddr,
          fee: ethers.formatUnits(config.fee, 18),
          baseFee: ethers.formatUnits(config.baseFee, 18),
          timeout: config.requestTimeoutSeconds.toString()
        };

        const linkContract = new ethers.Contract(config.linkAddr, LINK_ABI, this.provider);

        // 2. LINK Token Status
        console.log('💰 Checking LINK token status...');
        const [userBalance, allowance, contractBalance] = await Promise.all([
          linkContract.balanceOf(this.walletAddress),
          linkContract.allowance(this.walletAddress, this.contractAddress),
          linkContract.balanceOf(this.contractAddress)
        ]);

        debug.checks.link = {
          success: true,
          userBalance: ethers.formatUnits(userBalance, 18),
          allowance: ethers.formatUnits(allowance, 18),
          contractBalance: ethers.formatUnits(contractBalance, 18)
        };

        // 3. Oracle Registration for Class
        console.log(`🎯 Checking oracles for class ${contractClass}...`);
        try {
          const oracles = await this.contract.getRegisteredOracles(contractClass);
          debug.checks.oracles = {
            success: true,
            count: oracles.length,
            addresses: oracles
          };

          if (oracles.length === 0) {
            debug.checks.oracles.error = `No oracles registered for class ${contractClass}`;
            console.error(`❌ CRITICAL: No oracles registered for class ${contractClass}`);
          } else {
            // Check first few oracle details
            const oracleDetails = [];
            for (let i = 0; i < Math.min(3, oracles.length); i++) {
              try {
                const info = await this.contract.getOracleInfo(oracles[i]);
                oracleDetails.push({
                  address: oracles[i],
                  jobId: info.jobId,
                  isActive: info.isActive,
                  class: info.class.toString(),
                  node: info.node
                });
              } catch (err) {
                oracleDetails.push({
                  address: oracles[i],
                  error: err.message
                });
              }
            }
            debug.checks.oracles.details = oracleDetails;
          }
        } catch (err) {
          debug.checks.oracles = {
            success: false,
            error: err.message
          };
        }

        // 4. Fee Calculation
        console.log('💸 Checking fee calculation...');
        try {
          const testMaxFee = ethers.parseUnits("0.01", 18);
          const totalFee = await this.contract.maxTotalFee(testMaxFee);
          
          debug.checks.fees = {
            success: true,
            maxFeeInput: ethers.formatUnits(testMaxFee, 18),
            totalFeeRequired: ethers.formatUnits(totalFee, 18),
            allowanceSufficient: allowance >= totalFee
          };

          if (allowance < totalFee) {
            debug.checks.fees.shortfall = ethers.formatUnits(totalFee - allowance, 18);
            console.error(`❌ INSUFFICIENT ALLOWANCE: Need ${ethers.formatUnits(totalFee, 18)} LINK, have ${ethers.formatUnits(allowance, 18)} LINK`);
          }
        } catch (err) {
          debug.checks.fees = {
            success: false,
            error: err.message
          };
        }

      } catch (err) {
        debug.checks.config = {
          success: false,
          error: err.message
        };
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
      
      // Use staticCall to simulate the transaction without executing
      await this.contract.requestAIEvaluationWithApproval.staticCall(
        cidArray,
        textAddendum,
        alpha,
        maxFee,
        estimatedBaseCost,
        maxFeeBasedScalingFactor,
        contractClass
      );
      
      console.log('✅ Dry run successful - transaction should work');
      return { success: true };
      
    } catch (err) {
      console.error('❌ Dry run failed:', err.message);
      
      let revertReason = 'Unknown';
      
      // Try to extract revert reason
      if (err.data) {
        try {
          // Attempt to decode common revert reasons
          if (err.data.includes('4e487b71')) {
            revertReason = 'Panic error (assertion failure)';
          } else if (err.data.includes('08c379a0')) {
            revertReason = 'Revert with string message';
          }
        } catch (decodeErr) {
          // Ignore decode errors
        }
      }
      
      return {
        success: false,
        error: err.message,
        revertReason,
        data: err.data
      };
    }
  }

  /**
   * Check oracle registration across multiple classes
   * @param {Array<number>} classesToCheck - Array of class numbers to check
   * @returns {Promise<Object>} - Object mapping class to oracle info
   */
  async checkMultipleClasses(classesToCheck = [0, 1, 128, 256, 512, 600, 1000]) {
    const results = {};
    
    console.log(`🔍 Checking oracle registration across classes: ${classesToCheck.join(', ')}`);
    
    for (const classNum of classesToCheck) {
      try {
        const oracles = await this.contract.getRegisteredOracles(classNum);
        results[classNum] = {
          count: oracles.length,
          oracles: oracles,
          hasOracles: oracles.length > 0
        };
        
        if (oracles.length > 0) {
          console.log(`✅ Class ${classNum}: ${oracles.length} oracles registered`);
        } else {
          console.log(`❌ Class ${classNum}: No oracles registered`);
        }
      } catch (err) {
        results[classNum] = {
          error: err.message,
          hasOracles: false
        };
        console.log(`⚠️ Class ${classNum}: Error checking - ${err.message}`);
      }
    }
    
    return results;
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

    // Add multi-class check to the debug report
    const multiClassCheck = await this.checkMultipleClasses();
    report.multiClassAnalysis = multiClassCheck;

    // Generate recommendations
    report.recommendations = this.generateRecommendations(report);

    console.log('📋 Debug Report:', report);
    return report;
  }

  generateRecommendations(report) {
    const recommendations = [];

    // Check for common issues
    if (!report.stateAnalysis.checks.oracles?.success || report.stateAnalysis.checks.oracles?.count === 0) {
      // Check if other classes have oracles available
      const availableClasses = [];
      if (report.multiClassAnalysis) {
        for (const [classNum, info] of Object.entries(report.multiClassAnalysis)) {
          if (info.hasOracles) {
            availableClasses.push(classNum);
          }
        }
      }

      if (availableClasses.length > 0) {
        recommendations.push({
          priority: 'HIGH',
          issue: 'No oracles registered',
          solution: `No oracles registered for class ${report.parameters.contractClass}. Try using one of these classes instead: ${availableClasses.join(', ')}`
        });
      } else {
        recommendations.push({
          priority: 'HIGH',
          issue: 'No oracles registered',
          solution: `Register oracles for class ${report.parameters.contractClass} before submitting requests`
        });
      }
    }

    if (report.stateAnalysis.checks.fees?.success && !report.stateAnalysis.checks.fees?.allowanceSufficient) {
      recommendations.push({
        priority: 'HIGH',
        issue: 'Insufficient LINK allowance',
        solution: `Approve ${report.stateAnalysis.checks.fees.totalFeeRequired} LINK for the contract`
      });
    }

    if (!report.dryRun.success) {
      recommendations.push({
        priority: 'CRITICAL',
        issue: 'Transaction will revert',
        solution: 'Fix the underlying contract validation issues before retrying'
      });
    }

    if (report.stateAnalysis.checks.link?.userBalance && parseFloat(report.stateAnalysis.checks.link.userBalance) < 0.1) {
      recommendations.push({
        priority: 'MEDIUM',
        issue: 'Low LINK balance',
        solution: 'Consider getting more LINK tokens from faucet or bridge'
      });
    }

    return recommendations;
  }
}

// Usage example:
// const debugger = new ContractDebugger(provider, contractAddress, walletAddress);
// const report = await debugger.generateDebugReport(cidArray, textAddendum, alpha, maxFee, estimatedBaseCost, maxFeeBasedScalingFactor, contractClass); 