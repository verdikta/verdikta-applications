'use strict';
const { ethers } = require('ethers');
const fs = require('fs');
const { digest } = require('./config');
const { project } = require('./ledger');
const evidence = require('./evidence');
const rawAbi = require('../../onchain/abi/BountyEscrow.json');
const abi = rawAbi.abi || rawAbi;
const { LEGACY_SUBMISSION_PREPARED_ABI } = require('../utils/submissionEvents');
const iface = new ethers.Interface([...abi, LEGACY_SUBMISSION_PREPARED_ABI]);
const ZERO = ethers.ZeroAddress;
class Indexer {
  constructor(c, store, provider, validators = evidence, createContract = (a, abi, p) => new ethers.Contract(a, abi, p)) { this.c=c; this.store=store; this.provider=provider; this.validators=validators; this.busy=false; this.createContract=createContract; }
  async reconcile(now = Math.floor(Date.now()/1000)) {
    if (this.busy) return; this.busy=true;
    try {
      const c=this.c, p=this.provider;
      if (Number((await p.getNetwork()).chainId) !== 8453) throw new Error('WRONG_CHAIN');
      const versions = await this.validators.templateDigests();
      if (!c.approvedTemplates.every(t => versions.some(v => v.id === t.id && v.sha256 === t.sha256))) throw new Error('TEMPLATE_VERSION_CHANGED');
      const latest = await p.getBlock('latest'), finalized = await p.getBlock('finalized');
      const to = Math.min(finalized.number, latest.number - c.confirmations);
      const tip = await p.getBlock(to);
      if (!tip || now - tip.timestamp > c.maxAgeSeconds || tip.timestamp > now) throw new Error('CHAIN_STALE');
      const old = this.store.state.chain;
      for (const d of c.deployments) {
        if (ethers.keccak256(await p.getCode(d.address, to)) !== d.codeHash.toLowerCase()) throw new Error('CODE_HASH_MISMATCH');
        if (d.fromBlock > 0 && await p.getCode(d.address, d.fromBlock - 1) !== '0x') throw new Error('HISTORY_START_NOT_CREATION');
        const prior = old.coverage[d.address];
        if (prior && (to < prior.to || (await p.getBlock(prior.to))?.hash !== prior.hash)) {
          this.store.transact(s => { s.chain={ logs:[], coverage:{}, checkedAt:0, error:'REORG_REBUILD_REQUIRED' }; s.bounties=[]; });
          throw new Error('REORG_REBUILD_REQUIRED');
        }
      }
      const logs = [...old.logs], coverage = {};
      for (const d of c.deployments) {
        let from = old.coverage[d.address]?.to + 1 || d.fromBlock;
        if (to < d.fromBlock) throw new Error('DEPLOYMENT_NOT_COVERED');
        for (; from <= to; from += c.logChunkSize) {
          const fetched = await p.getLogs({ address:d.address, fromBlock:from, toBlock:Math.min(to, from+c.logChunkSize-1) });
          for (const log of fetched) {
            if (log.removed) throw new Error('REORG_RETRY');
            const parsed = iface.parseLog(log);
            if (!parsed) continue;
            const block = await p.getBlock(log.blockNumber);
            if (block?.hash !== log.blockHash) throw new Error('REORG_RETRY');
            const args = Object.fromEntries(parsed.fragment.inputs.map((input,i) => [input.name, typeof parsed.args[i] === 'bigint' ? parsed.args[i].toString() : parsed.args[i]]));
            // The checked-in ABI calls the payout field amountWei; tolerate the service ABI alias.
            if (parsed.name === 'PayoutSent') args.amountWei ??= args.amount;
            logs.push({ contract:d.address, name:parsed.name, args, blockNumber:log.blockNumber, blockHash:log.blockHash,
              index:log.index, tx:log.transactionHash, at:block.timestamp });
          }
        }
        coverage[d.address] = { from:d.fromBlock, to, hash:tip.hash, adapter:d.adapter };
      }
      const unique = new Map(logs.map(l => [`${l.contract}:${l.tx}:${l.index}`, l]));
      const ordered = [...unique.values()].sort((a,b) => a.blockNumber-b.blockNumber || a.index-b.index);
      const view = project(ordered, c.startAt);
      // Event counts must match contract storage: unknown legacy event signatures cannot silently imply newness.
      for (const d of c.deployments) {
        const contract = this.createContract(d.address, ['function bountyCount() view returns (uint256)', 'function submissionCount(uint256) view returns (uint256)'], p);
        const rows = view.bounties.filter(b => b.contract === d.address);
        if (BigInt(rows.length) !== await contract.bountyCount({ blockTag:to })) throw new Error('HISTORY_COUNT_MISMATCH');
        for (const b of rows) if (BigInt(b.submissions.length) !== await contract.submissionCount(b.id, { blockTag:to })) throw new Error('HISTORY_COUNT_MISMATCH');
      }
      const reviews = c.reviewFile ? JSON.parse(fs.readFileSync(c.reviewFile,'utf8')) : { bounties:{} };
      for (const b of view.bounties) {
        const d = c.deployments.find(d => d.address === b.contract);
        if (!d.campaign || b.createdAt < c.startAt || b.createdAt >= c.endAt) continue;
        try {
          const contract = this.createContract(b.contract, abi, p);
          const onchain = await contract.getBounty(b.id, { blockTag:to });
          b.open = onchain.targetHunter === ZERO;
          const prior = this.store.state.bounties.find(x => x.key === b.key && x.evaluationCid === b.evaluationCid);
          b.workOrder = prior?.workOrder?.ok ? prior.workOrder : await this.validators.workOrder(b, c);
          const review = reviews.bounties?.[b.key];
          // Review binds to immutable chain package, never just a reused numeric bounty id.
          if (review?.evaluationCid === b.evaluationCid && review?.requestDigest === b.workOrder.requestDigest
            && typeof review.reviewer === 'string' && review.reviewer.length > 0 && typeof review.reason === 'string' && review.reason.length > 0
            && typeof review.reviewedAt === 'string' && /Z$/.test(review.reviewedAt) && Number.isFinite(Date.parse(review.reviewedAt))
            && Array.isArray(review.independentHunters) && review.independentHunters.every(a => /^0x[0-9a-f]{40}$/.test(a))
            && Array.isArray(review.distinctFrom) && review.distinctFrom.every(k => /^8453:0x[0-9a-f]{40}:[0-9]+$/.test(k))) b.review = review;
          for (const s of b.submissions) {
            const chainSub = await contract.getSubmission(b.id, s.id, { blockTag:to });
            s.hunterCid = chainSub.hunterCid;
            const prevSub = prior?.submissions?.find(x => x.id === s.id && x.hunterCid === s.hunterCid && x.packageValid);
            try { s.packageValid = !!prevSub || await this.validators.submission(b,s); } catch { s.packageValid = false; }
          }
        } catch { b.evidenceError='EVIDENCE_UNAVAILABLE_OR_INVALID'; b.workOrder = { ok:false }; }
      }
      const counts = new Map();
      for (const b of view.bounties) if (b.workOrder?.ok) counts.set(b.workOrder.requestDigest, (counts.get(b.workOrder.requestDigest)||0)+1);
      for (const b of view.bounties) b.duplicate = counts.get(b.workOrder?.requestDigest) > 1;
      if ((await p.getBlock(to))?.hash !== tip.hash) throw new Error('REORG_RETRY');
      // Publish a coherent generation only after every chain scan has succeeded.
      this.store.transact(s => {
        s.chain = { logs:ordered, coverage, checkedAt:now, error:null, historyComplete:c.historyInventoryComplete,
          finalizedBlock:to, finalizedTimestamp:tip.timestamp, generation:digest({ coverage, reviews }) };
        s.bounties=view.bounties; s.history=view.history;
      });
    } catch (e) {
      const codes = ['WRONG_CHAIN','CHAIN_STALE','CODE_HASH_MISMATCH','REORG_REBUILD_REQUIRED','REORG_RETRY','DEPLOYMENT_NOT_COVERED','HISTORY_START_NOT_CREATION','HISTORY_COUNT_MISMATCH','TEMPLATE_VERSION_CHANGED'];
      const code = codes.includes(e.message) ? e.message : 'RECONCILIATION_FAILED_RETRY';
      this.store.state.chain.error = code;
      try { this.store.transact(s => { s.chain.error = code; }); } catch { this.store.failed = true; }
    } finally { this.busy=false; }
  }
}
module.exports = { Indexer, iface, abi };
