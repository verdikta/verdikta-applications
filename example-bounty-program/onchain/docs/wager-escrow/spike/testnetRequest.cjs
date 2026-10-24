#!/usr/bin/env node
// NOT RUN YET. One live 3-outcome aggregator request on Base Sepolia, in two phases.
//
//   1. Build and pin the package (see SPIKE.md), then:
//        PRIVATE_KEY=<throwaway testnet key> node testnetRequest.cjs start <packageCid>
//      prints the aggId. Cost: maxTotalFee(0.00002 ETH) = 0.00024 testnet ETH + gas; the
//      unspent part is credited back to the sender (ethOwed) at settlement.
//   2. About 5-10 minutes later (the aggregator's response timeout is 300 s):
//        node testnetRequest.cjs check <aggId>
//      prints the score vector. Expect length 3 in [NO_WINNER, SIDE_A, SIDE_B] order.
//
// Needs `ethers` v6 on NODE_PATH (e.g. this project's onchain/node_modules).

const { ethers } = require('ethers');

const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
const AGGREGATOR = '0xe8a385E473EA710c5a88Cc72681a16a26fe380e4'; // Base Sepolia, ETH-funded
const CLASS = 128;
const MAX_ORACLE_FEE = ethers.parseEther('0.00002');
const BASE_COST = ethers.parseEther('0.00001');
const SCALING = 3;
const ALPHA = 500;

const abi = [
  'function requestAIEvaluationWithApproval(string[] cids, string addendum, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeScaling, uint64 jobClass) payable returns (bytes32)',
  'function maxTotalFee(uint256) view returns (uint256)',
  'function ethOwed(address) view returns (uint256)',
  'function getEvaluation(bytes32) view returns (uint256[], string, bool)',
  'function getAggregationStatus(bytes32) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)',
  'function maxLikelihoodLength() view returns (uint256)',
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
];

(async () => {
  const [mode, arg] = process.argv.slice(2);
  const provider = new ethers.JsonRpcProvider(RPC);
  if (mode === 'start') {
    if (!/^[A-Za-z0-9]{46,100}$/.test(arg || '')) throw new Error('usage: start <packageCid>');
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const agg = new ethers.Contract(AGGREGATOR, abi, signer);
    const [maxTotal, credit, maxLen] = await Promise.all([
      agg.maxTotalFee(MAX_ORACLE_FEE), agg.ethOwed(signer.address), agg.maxLikelihoodLength()]);
    const value = maxTotal > credit ? maxTotal - credit : 0n;
    console.log({ signer: signer.address, maxTotal: ethers.formatEther(maxTotal), credit: ethers.formatEther(credit), value: ethers.formatEther(value), maxLikelihoodLength: maxLen.toString() });
    const args = [[arg], '', ALPHA, MAX_ORACLE_FEE, BASE_COST, SCALING, CLASS];
    await agg.requestAIEvaluationWithApproval.staticCall(...args, { value }); // revert reasons before spending gas
    const rcpt = await (await agg.requestAIEvaluationWithApproval(...args, { value })).wait();
    const ev = rcpt.logs.map((l) => { try { return agg.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'RequestAIEvaluation');
    console.log({ tx: rcpt.hash, aggId: ev.args.aggRequestId });
  } else if (mode === 'check') {
    const agg = new ethers.Contract(AGGREGATOR, abi, provider);
    const [scores, cids, ok] = await agg.getEvaluation(arg);
    const status = await agg.getAggregationStatus(arg);
    console.log({ ok, length: scores.length, scores: scores.map(String), justificationCids: cids, isComplete: status.isComplete, failed: status.failed, commits: `${status.commitReceived}/${status.commitExpected}`, reveals: `${status.responseCount}/${status.requiredN}` });
  } else {
    throw new Error('usage: start <packageCid> | check <aggId>');
  }
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
