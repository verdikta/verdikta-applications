#!/usr/bin/env node

// Debug script for the ETH-funded ReputationAggregator.
// Arbiters are paid in ETH (not LINK): requestAIEvaluationWithApproval is payable and the
// requester prepays maxTotalFee() in msg.value; unspent ETH is refunded as an on-chain
// ethOwed credit. So this script checks the requester's ETH balance + ethOwed credit vs.
// the worst-case prepay, then dry-runs the payable request — there is no LINK to inspect.
//
// Usage: node debug-contract.js <contract_address> <wallet_address> <class> [rpc_url]
//   rpc_url defaults to Base Sepolia. For mainnet pass https://mainnet.base.org.

const { ethers } = require('ethers');

const CONTRACT_ABI = [
  // Legacy view: still present on the ETH contract; linkAddr is informational only now.
  "function getContractConfig() view returns (address oracleAddr, address linkAddr, bytes32 jobId, uint256 currentFee)",
  "function responseTimeoutSeconds() view returns (uint256)",
  "function maxTotalFee(uint256 maxFee) view returns (uint256)",
  "function maxOracleFee() view returns (uint256)",
  "function ethOwed(address) view returns (uint256)",
  // The payable request entry point we want to dry-run.
  "function requestAIEvaluationWithApproval(string[] memory cidArray, string memory textAddendum, uint256 alpha, uint256 maxFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 class) payable returns (bytes32)"
];

async function debugContract() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: node debug-contract.js <contract_address> <wallet_address> <class> [rpc_url]');
    console.log('Example (testnet): node debug-contract.js 0xe8a385E473EA710c5a88Cc72681a16a26fe380e4 0xYourWallet 128');
    console.log('Example (mainnet): node debug-contract.js 0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a 0xYourWallet 128 https://mainnet.base.org');
    process.exit(1);
  }

  const [contractAddr, walletAddr, classNum, rpcArg] = args;
  const contractClass = parseInt(classNum);
  const rpcUrl = rpcArg || 'https://sepolia.base.org';

  console.log('🔍 Debugging ETH-funded Aggregator Contract');
  console.log('===========================================');
  console.log(`Contract: ${contractAddr}`);
  console.log(`Wallet:   ${walletAddr}`);
  console.log(`Class:    ${contractClass}`);
  console.log(`RPC:      ${rpcUrl}`);
  console.log('');

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddr, CONTRACT_ABI, provider);

    // Presence check first — a missing contract is the most common "wrong network/address".
    const code = await provider.getCode(contractAddr);
    if (code === '0x') {
      console.log(`❌ No contract code at ${contractAddr} on this RPC. Wrong network or address?`);
      return;
    }

    console.log('📋 CONTRACT CONFIGURATION');
    console.log('========================');
    try {
      const config = await contract.getContractConfig();
      console.log(`✅ LINK Token Address (informational): ${config.linkAddr}`);
      console.log(`✅ Response Timeout: ${await contract.responseTimeoutSeconds()} seconds`);
      const ceiling = await contract.maxOracleFee().catch(() => null);
      if (ceiling != null) console.log(`✅ Max Oracle Fee ceiling: ${ethers.formatEther(ceiling)} ETH`);
    } catch (err) {
      console.log(`❌ Error getting contract config: ${err.message}`);
    }

    console.log('');
    console.log('💰 REQUESTER ETH STATUS');
    console.log('======================');
    const ethBalance = await provider.getBalance(walletAddr);
    const credit = await contract.ethOwed(walletAddr).catch(() => 0n);
    console.log(`✅ Wallet ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);
    console.log(`✅ Prepay credit (ethOwed): ${ethers.formatEther(credit)} ETH`);

    console.log('');
    console.log('💸 FEE / PREPAY CALCULATION');
    console.log('==========================');
    const testMaxFee = ethers.parseUnits("0.0001", 18); // typical arbiter fee (ETH)
    let valueToAttach = 0n;
    try {
      const totalFee = await contract.maxTotalFee(testMaxFee);
      valueToAttach = totalFee > credit ? totalFee - credit : 0n;
      console.log(`✅ Worst-case prepay (maxTotalFee): ${ethers.formatEther(totalFee)} ETH`);
      console.log(`✅ ETH to attach (after credit):    ${ethers.formatEther(valueToAttach)} ETH`);
      if (ethBalance < valueToAttach) {
        console.log(`❌ INSUFFICIENT ETH!`);
        console.log(`   Need:    ${ethers.formatEther(valueToAttach)} ETH (plus gas)`);
        console.log(`   Have:    ${ethers.formatEther(ethBalance)} ETH`);
        console.log(`   Missing: ${ethers.formatEther(valueToAttach - ethBalance)} ETH`);
      } else {
        console.log(`✅ ETH balance sufficient for the prepay`);
      }
    } catch (err) {
      console.log(`❌ Error calculating fees: ${err.message}`);
    }

    console.log('');
    console.log('🧪 DRY RUN TEST');
    console.log('==============');
    try {
      console.log('Attempting dry run of requestAIEvaluationWithApproval (payable)...');
      const testCidArray = ['QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS'];
      const testAddendum = '';
      const testAlpha = 500;
      const testEstimatedBaseCost = testMaxFee / 100n; // 1% of maxFee
      const testScalingFactor = 10;

      await contract.requestAIEvaluationWithApproval.staticCall(
        testCidArray,
        testAddendum,
        testAlpha,
        testMaxFee,
        testEstimatedBaseCost,
        testScalingFactor,
        contractClass,
        { value: valueToAttach, from: walletAddr }
      );

      console.log('✅ Dry run successful - transaction should work');
    } catch (err) {
      console.log(`❌ Dry run failed: ${err.message}`);
      console.log('   Likely causes: no active arbiters for this class, the fee ceiling excluded them,');
      console.log('   or insufficient attached value. Try a different class.');
      // Decode a custom error if present (e.g. InactiveOracle, BadSelectionCount, InsufficientPayment).
      if (err.data) {
        try {
          const parsed = contract.interface.parseError(err.data);
          if (parsed) console.log(`   Custom error: ${parsed.name}`);
        } catch {}
        console.log(`   Revert data: ${err.data}`);
      }
    }
  } catch (err) {
    console.error(`❌ Fatal error: ${err.message}`);
  }
}

debugContract().catch(console.error);
