#!/usr/bin/env node

// Debug script for aggregator contract issues
// Usage: node debug-contract.js <contract_address> <wallet_address> <class>

const { ethers } = require('ethers');

const CONTRACT_ABI = [
  // Core functions we need to debug
  "function getContractConfig() view returns (tuple(address linkAddr, uint256 fee, uint256 baseFee, uint256 requestTimeoutSeconds))",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxTotalFee(uint256 maxFee) view returns (uint256)",
  "function getRegisteredOracles(uint256 class) view returns (address[])",
  "function getOracleInfo(address oracle) view returns (tuple(string jobId, bool isActive, uint256 class, address node))",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  // Try to call the actual function that's failing
  "function requestAIEvaluationWithApproval(string[] memory cidArray, string memory textAddendum, uint256 alpha, uint256 maxFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint256 class) payable returns (bytes32)"
];

const LINK_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

async function debugContract() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: node debug-contract.js <contract_address> <wallet_address> <class>');
    console.log('Example: node debug-contract.js 0x65863e5e0B2c2968dBbD1c95BDC2e0EA598E5e02 0xF234d765C10BEf125aF6Ce457f63f7341E5F248C 600');
    process.exit(1);
  }

  const [contractAddr, walletAddr, classNum] = args;
  const contractClass = parseInt(classNum);

  console.log('🔍 Debugging Aggregator Contract');
  console.log('================================');
  console.log(`Contract: ${contractAddr}`);
  console.log(`Wallet: ${walletAddr}`);
  console.log(`Class: ${contractClass}`);
  console.log('');

  try {
    // Connect to Base Sepolia
    const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
    const contract = new ethers.Contract(contractAddr, CONTRACT_ABI, provider);

    console.log('📋 CONTRACT CONFIGURATION');
    console.log('========================');
    
    try {
      const config = await contract.getContractConfig();
      console.log(`✅ LINK Token Address: ${config.linkAddr}`);
      console.log(`✅ Fee: ${ethers.formatUnits(config.fee, 18)} LINK`);
      console.log(`✅ Base Fee: ${ethers.formatUnits(config.baseFee, 18)} LINK`);
      console.log(`✅ Request Timeout: ${config.requestTimeoutSeconds} seconds`);

      const linkContract = new ethers.Contract(config.linkAddr, LINK_ABI, provider);

      console.log('');
      console.log('💰 LINK TOKEN STATUS');
      console.log('===================');
      
      // Check user's LINK balance
      const userBalance = await linkContract.balanceOf(walletAddr);
      console.log(`✅ User LINK Balance: ${ethers.formatUnits(userBalance, 18)} LINK`);
      
      // Check allowance
      const allowance = await linkContract.allowance(walletAddr, contractAddr);
      console.log(`✅ Current Allowance: ${ethers.formatUnits(allowance, 18)} LINK`);
      
      // Check contract LINK balance (for fee payments)
      const contractBalance = await linkContract.balanceOf(contractAddr);
      console.log(`✅ Contract LINK Balance: ${ethers.formatUnits(contractBalance, 18)} LINK`);

      console.log('');
      console.log('🎯 CLASS VALIDATION');
      console.log('==================');
      
      // Check registered oracles for this class
      try {
        const oracles = await contract.getRegisteredOracles(contractClass);
        console.log(`✅ Registered Oracles for Class ${contractClass}: ${oracles.length}`);
        
        if (oracles.length === 0) {
          console.log('❌ ERROR: No oracles registered for this class!');
          console.log('   This will cause the transaction to revert.');
          console.log('   Please register oracles for class', contractClass);
        } else {
          console.log('   Oracle addresses:');
          for (let i = 0; i < Math.min(oracles.length, 5); i++) {
            console.log(`   ${i + 1}. ${oracles[i]}`);
            try {
              const oracleInfo = await contract.getOracleInfo(oracles[i]);
              console.log(`      Job ID: ${oracleInfo.jobId}`);
              console.log(`      Active: ${oracleInfo.isActive}`);
              console.log(`      Class: ${oracleInfo.class}`);
              console.log(`      Node: ${oracleInfo.node}`);
            } catch (err) {
              console.log(`      ❌ Could not get oracle info: ${err.message}`);
            }
          }
          if (oracles.length > 5) {
            console.log(`   ... and ${oracles.length - 5} more`);
          }
        }
      } catch (err) {
        console.log(`❌ Error checking oracles: ${err.message}`);
      }

      console.log('');
      console.log('💸 FEE CALCULATION');
      console.log('=================');
      
      // Test fee calculation with the parameters that were likely used
      const testMaxFee = ethers.parseUnits("0.01", 18); // Default from the app
      try {
        const totalFee = await contract.maxTotalFee(testMaxFee);
        console.log(`✅ Max Total Fee: ${ethers.formatUnits(totalFee, 18)} LINK`);
        
        if (allowance < totalFee) {
          console.log(`❌ INSUFFICIENT ALLOWANCE!`);
          console.log(`   Required: ${ethers.formatUnits(totalFee, 18)} LINK`);
          console.log(`   Current:  ${ethers.formatUnits(allowance, 18)} LINK`);
          console.log(`   Missing:  ${ethers.formatUnits(totalFee - allowance, 18)} LINK`);
        } else {
          console.log(`✅ Allowance sufficient for fees`);
        }
      } catch (err) {
        console.log(`❌ Error calculating fees: ${err.message}`);
      }

      console.log('');
      console.log('🧪 DRY RUN TEST');
      console.log('==============');
      
      // Try to simulate the call that failed
      try {
        console.log('Attempting dry run of requestAIEvaluationWithApproval...');
        
        // Use the same parameters as in the app
        const testCidArray = ['QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS'];
        const testAddendum = '';
        const testAlpha = 500;
        const testEstimatedBaseCost = testMaxFee / 100n; // 1% of maxFee
        const testScalingFactor = 10;
        
        // This should revert with the same error if there's an issue
        await contract.requestAIEvaluationWithApproval.staticCall(
          testCidArray,
          testAddendum,
          testAlpha,
          testMaxFee,
          testEstimatedBaseCost,
          testScalingFactor,
          contractClass
        );
        
        console.log('✅ Dry run successful - transaction should work');
        
      } catch (err) {
        console.log(`❌ Dry run failed: ${err.message}`);
        console.log('   This confirms the issue is in the contract validation');
        
        // Try to decode the revert reason
        if (err.data) {
          console.log(`   Revert data: ${err.data}`);
        }
      }

    } catch (err) {
      console.log(`❌ Error getting contract config: ${err.message}`);
    }

  } catch (err) {
    console.error(`❌ Fatal error: ${err.message}`);
  }
}

debugContract().catch(console.error); 