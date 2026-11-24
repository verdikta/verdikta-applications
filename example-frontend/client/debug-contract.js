#!/usr/bin/env node

// Debug script for the v2 ETH-funded ReputationAggregator.
// Arbiters are paid in ETH (not LINK): requestAIEvaluationWithApproval is payable and the
// requester prepays maxTotalFee(maxFee, minFee, withBeacons, K, P); msg.value comes first and the
// requester's ethOwed credit covers any shortfall. Unspent ETH comes back as ethOwed credit.
// This script checks the requester's ETH balance + ethOwed credit vs. the worst-case prepay,
// then dry-runs the 10-argument payable request. There is no LINK to inspect.
//
// The jury is the request's own (its last argument, Jury {K, M, N, P, timeout}): one
// aggregator serves every size, bounded by the owner's maxJury() and maxTimeout() (and
// tPlus(), which every timeout must exceed). A jury outside the rules reverts BadJury.
//
// A v2 request does not draw the jury: the requester then sends drawJury(aggId) from block
// B+2 and promote(aggId) after the commit phase (the Run Query page does this), so an empty
// arbiter pool does not show up in this dry run.
//
// Usage: node debug-contract.js <contract_address> <wallet_address> <class> [rpc_url] [min_fee_eth] [with_beacons] [jury]
//   contract_address may be "env" to use AGGREGATOR_ADDRESS from the environment.
//   jury is K/M/N/P/timeout, default 6/5/4/3/300 (Small). The class presets: Small
//   6/5/4/3/300, Medium 8/5/4/3/300, Large 21/16/13/10/300, Jumbo 50/38/27/17/600 (beacons on).
//   rpc_url defaults to Base Sepolia. For mainnet pass https://mainnet.base.org.
//   No v2 aggregator address is filled in here: use the one your deployment published.

const { ethers } = require('ethers');

const CONTRACT_ABI = [
  'function maxJury() view returns (uint8)',
  'function maxTimeout() view returns (uint40)',
  'function tPlus() view returns (uint40)',
  'function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P) view returns (uint256)',
  'function maxOracleFee() view returns (uint256)',
  'function ethOwed(address) view returns (uint256)',
  // The payable request entry point we want to dry-run.
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxFee, uint256 minFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass, bool withBeacons, (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) jury) payable returns (bytes32)',
  'error BadInput()',
  'error BadJury()',
  'error KeeperNotSet()',
  'error InsufficientPayment()',
];

async function debugContract() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: node debug-contract.js <contract_address|env> <wallet_address> <class> [rpc_url] [min_fee_eth] [with_beacons] [K/M/N/P/timeout]');
    console.log('Example (testnet): node debug-contract.js <v2 aggregator address> 0xYourWallet 128');
    console.log('Example (mainnet): AGGREGATOR_ADDRESS=<v2 aggregator address> node debug-contract.js env 0xYourWallet 128 https://mainnet.base.org');
    console.log('Example (fee floor 0.0002 ETH, beacons on): node debug-contract.js <v2 aggregator address> 0xYourWallet 128 "" 0.0002 true');
    console.log('Example (Jumbo jury): node debug-contract.js <v2 aggregator address> 0xYourWallet 128 "" 0 true 50/38/27/17/600');
    process.exit(1);
  }

  const [contractArg, walletAddr, classNum, rpcArg, minFeeArg, beaconsArg, juryArg] = args;
  const contractAddr = contractArg === 'env' ? process.env.AGGREGATOR_ADDRESS : contractArg;
  if (!contractAddr || !ethers.isAddress(contractAddr)) {
    console.log('❌ No valid aggregator address. Pass the v2 aggregator address, or "env" with AGGREGATOR_ADDRESS set.');
    process.exit(1);
  }
  const contractClass = parseInt(classNum);
  const rpcUrl = rpcArg || 'https://sepolia.base.org';
  const testMinFee = minFeeArg ? ethers.parseEther(minFeeArg) : 0n; // fee floor (0 = none)
  const testWithBeacons = beaconsArg === 'true';
  const [K, M, N, P, timeout] = (juryArg || '6/5/4/3/300').split('/').map(Number);
  const jury = { K, M, N, P, timeout };
  if (![K, M, N, P, timeout].every(Number.isInteger)) {
    console.log('❌ The jury must be K/M/N/P/timeout, e.g. 6/5/4/3/300.');
    process.exit(1);
  }

  console.log('🔍 Debugging the v2 ETH-funded Aggregator Contract');
  console.log('===========================================');
  console.log(`Contract: ${contractAddr}`);
  console.log(`Wallet:   ${walletAddr}`);
  console.log(`Class:    ${contractClass}`);
  console.log(`RPC:      ${rpcUrl}`);
  console.log(`Fee floor: ${ethers.formatEther(testMinFee)} ETH, beacons: ${testWithBeacons}`);
  console.log(`Jury:     K=${K} drawn, M=${M} promoted, N=${N} counted, P=${P} clustered, timeout ${timeout} s`);
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
      const [maxJury, maxTimeout, tPlus, ceiling] = (await Promise.all([
        contract.maxJury(), contract.maxTimeout(), contract.tPlus(), contract.maxOracleFee(),
      ]));
      console.log(`✅ Jury limits: K up to ${maxJury} (and the keeper's shortlist); timeout above ${tPlus} s (T+, the commit window) and at most ${maxTimeout} s`);
      console.log(`✅ Max Oracle Fee ceiling: ${ethers.formatEther(ceiling)} ETH`);
      const shape = !(K >= M && M >= N && N >= P && P >= 1) ? 'need K >= M >= N >= P >= 1'
        : N > 40 ? 'N may be at most 40'
        : P < 2 && N !== 1 ? 'P must be at least 2 unless N = 1'
        : K > Number(maxJury) ? `K is above maxJury (${maxJury})`
        : timeout <= Number(tPlus) || timeout > Number(maxTimeout) ? `timeout must be above ${tPlus} s and at most ${maxTimeout} s`
        : null;
      console.log(shape ? `❌ This jury would be refused (BadJury): ${shape}` : '✅ The jury fits the rules and limits');
    } catch (err) {
      // v1 (and a v2 aggregator from before the per-request jury) has none of these getters
      console.log(`❌ Not a v2 aggregator with per-request juries (or not reachable): ${err.message}`);
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
      const totalFee = await contract.maxTotalFee(testMaxFee, testMinFee, testWithBeacons, K, P);
      valueToAttach = totalFee > credit ? totalFee - credit : 0n;
      console.log(`✅ Worst-case prepay (maxTotalFee(maxFee, minFee, withBeacons, K, P)): ${ethers.formatEther(totalFee)} ETH`);
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
        testMinFee,
        testEstimatedBaseCost,
        testScalingFactor,
        contractClass,
        testWithBeacons,
        jury,
        { value: valueToAttach, from: walletAddr }
      );

      console.log('✅ Dry run successful - transaction should work');
    } catch (err) {
      console.log(`❌ Dry run failed: ${err.message}`);
      console.log('   Likely causes: BadJury (the jury breaks a rule or the limits above), BadInput (base cost not below the clamped fee, alpha > 1000, scaling');
      console.log('   outside 1..65535, bad CIDs), InsufficientPayment, a paused aggregator, or beacons');
      console.log('   requested from an aggregator with no beacon contract.');
      // Decode a custom error if present (e.g. BadInput, InsufficientPayment).
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
