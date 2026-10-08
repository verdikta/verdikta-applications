'use strict';
const { ethers } = require('ethers');
const { digest } = require('./config');
const { project } = require('./ledger');
const evidence = require('./evidence');
const { EvidenceCache } = require('./cache');
const { readExceptions, applyIdentityReleases } = require('./exceptions');
const rawAbi = require('../../onchain/abi/BountyEscrow.json');
const abi = rawAbi.abi || rawAbi;
const iface = new ethers.Interface(abi);
class Indexer {
  constructor(
    config,
    store,
    provider,
    validators = evidence,
    createContract = (address, contractAbi, runner) =>
      new ethers.Contract(address, contractAbi, runner),
  ) {
    this.config = config;
    this.store = store;
    this.provider = provider;
    this.validators = validators;
    this.createContract = createContract;
    this.busy = false;
    this.evidenceFingerprint = evidence.evidenceFingerprint();
    this.cache = new EvidenceCache(
      structuredClone(store.state.evidenceCache || {}),
    );
  }
  async reconcile(now = Math.floor(Date.now() / 1000)) {
    if (this.busy) return;
    this.busy = true;
    this.cache.clock = () => now;
    let checkFailureLogged = false;
    const recordEvidenceFailure = (error) => {
      if (
        !evidence.isEvidenceError(error) ||
        error.message === 'EVIDENCE_CHECK_FAILED_RETRY'
      ) {
        if (!checkFailureLogged) {
          console.warn(
            'Campaign evidence check failed; retrying on the next cycle.',
          );
          checkFailureLogged = true;
        }
        return 'EVIDENCE_CHECK_FAILED_RETRY';
      }
      return error.message;
    };
    try {
      const config = this.config;
      const deployment = config.deployment;
      const provider = this.provider;
      const exceptions = readExceptions(config.exceptionsFile, deployment);
      if (Number((await provider.getNetwork()).chainId) !== 8453)
        throw new Error('WRONG_CHAIN');
      const latest = await provider.getBlock('latest');
      const finalized = await provider.getBlock('finalized');
      const toBlock = Math.min(
        finalized.number,
        latest.number - config.confirmations,
      );
      const previous = this.store.state.chain;
      if (previous.coverage && toBlock < previous.coverage.to) {
        this.store.transact((state) => {
          state.chain.lagNotice = {
            at: now,
            toBlock,
            coverageTo: previous.coverage.to,
          };
        });
        return;
      }
      const tip = await provider.getBlock(toBlock);
      if (
        !tip ||
        now - tip.timestamp > config.maxAgeSeconds ||
        tip.timestamp > now
      )
        throw new Error('CHAIN_STALE');
      if (previous.coverage) {
        const checkpoint = await provider.getBlock(previous.coverage.to);
        if (!checkpoint) throw new Error('RPC_LAGGING_RETRY');
        if (checkpoint.hash !== previous.coverage.hash) {
          this.store.transact((state) => {
            state.chain = {
              logs: [],
              coverage: null,
              checkedAt: 0,
              creationChecked: previous.creationChecked,
              error: 'REORG_REBUILD_REQUIRED',
            };
            state.bounties = [];
          });
          throw new Error('REORG_REBUILD_REQUIRED');
        }
      }
      if (
        ethers.keccak256(
          await provider.getCode(deployment.address, toBlock),
        ) !== deployment.codeHash
      )
        throw new Error('CODE_HASH_MISMATCH');
      if (
        !previous.creationChecked &&
        deployment.fromBlock > 0 &&
        (await provider.getCode(
          deployment.address,
          deployment.fromBlock - 1,
        )) !== '0x'
      )
        throw new Error('HISTORY_START_NOT_CREATION');
      if (toBlock < deployment.fromBlock)
        throw new Error('DEPLOYMENT_NOT_COVERED');
      const logs = [...previous.logs];
      for (
        let fromBlock = previous.coverage
          ? previous.coverage.to + 1
          : deployment.fromBlock;
        fromBlock <= toBlock;
        fromBlock += config.logChunkSize
      ) {
        const fetched = await provider.getLogs({
          address: deployment.address,
          fromBlock,
          toBlock: Math.min(toBlock, fromBlock + config.logChunkSize - 1),
        });
        for (const log of fetched) {
          if (log.removed) throw new Error('REORG_RETRY');
          const parsed = iface.parseLog(log);
          if (!parsed) continue;
          const block = await provider.getBlock(log.blockNumber);
          if (block?.hash !== log.blockHash) throw new Error('REORG_RETRY');
          const args = Object.fromEntries(
            parsed.fragment.inputs.map((input, index) => [
              input.name,
              typeof parsed.args[index] === 'bigint'
                ? parsed.args[index].toString()
                : parsed.args[index],
            ]),
          );
          if (parsed.name === 'PayoutSent') args.amountWei ??= args.amount;
          logs.push({
            contract: deployment.address,
            name: parsed.name,
            args,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            index: log.index,
            tx: log.transactionHash,
            at: block.timestamp,
          });
        }
      }
      const uniqueLogs = new Map(
        logs.map((log) => [`${log.tx}:${log.index}`, log]),
      );
      const orderedLogs = [...uniqueLogs.values()].sort(
        (first, second) =>
          first.blockNumber - second.blockNumber || first.index - second.index,
      );
      const view = project(orderedLogs, config.startAt);
      const contract = this.createContract(deployment.address, abi, provider);
      if (
        BigInt(view.bounties.length) !==
        (await contract.bountyCount({ blockTag: toBlock }))
      )
        throw new Error('HISTORY_COUNT_MISMATCH');
      const fetcher = (cid) => this.cache.fetch(cid, this.validators.fetchCid);
      for (const bounty of view.bounties) {
        if (
          BigInt(bounty.submissions.length) !==
          (await contract.submissionCount(bounty.id, { blockTag: toBlock }))
        )
          throw new Error('HISTORY_COUNT_MISMATCH');
        if (
          bounty.createdAt < config.startAt ||
          bounty.createdAt >= config.endAt
        )
          continue;
        const onchain = await contract.getBounty(bounty.id, {
          blockTag: toBlock,
        });
        bounty.open = onchain.targetHunter === ethers.ZeroAddress;
        try {
          bounty.evidence = await this.cache.check(
            bounty.evaluationCid,
            `bounty:${this.evidenceFingerprint}:${config.snapshotSetHash}:${bounty.threshold}`,
            () => this.validators.inspectBounty(bounty, config, fetcher),
          );
        } catch (error) {
          bounty.evidenceError = recordEvidenceFailure(error);
          bounty.evidence = { ok: false };
          continue;
        }
        for (const submission of bounty.submissions) {
          const chainSubmission = await contract.getSubmission(
            bounty.id,
            submission.id,
            { blockTag: toBlock },
          );
          submission.hunterCid = chainSubmission.hunterCid;
          try {
            submission.packageValid = await this.cache.check(
              submission.hunterCid,
              `submission:${this.evidenceFingerprint}:${config.snapshotSetHash}:${bounty.evidence.kind}:${bounty.evidence.templateId || 'custom'}:${bounty.evidence.scopeDigest}`,
              () => this.validators.submission(bounty, submission, fetcher),
            );
          } catch (error) {
            submission.packageValid = false;
            submission.evidenceError = recordEvidenceFailure(error);
          }
        }
      }
      const countsForDuplicates = (bounty) =>
        bounty.evidence?.ok &&
        !bounty.refunded &&
        !exceptions.denyBounties[bounty.key];
      const scopeCounts = new Map();
      for (const bounty of view.bounties) {
        if (countsForDuplicates(bounty))
          scopeCounts.set(
            bounty.evidence.scopeDigest,
            (scopeCounts.get(bounty.evidence.scopeDigest) || 0) + 1,
          );
      }
      for (const bounty of view.bounties)
        bounty.duplicate =
          !!countsForDuplicates(bounty) &&
          scopeCounts.get(bounty.evidence.scopeDigest) > 1;
      if ((await provider.getBlock(toBlock))?.hash !== tip.hash)
        throw new Error('REORG_RETRY');
      if (exceptions.identityReleases.length)
        applyIdentityReleases(this.store, exceptions.identityReleases);
      const coverage = {
        from: deployment.fromBlock,
        to: toBlock,
        hash: tip.hash,
      };
      this.store.transact((state) => {
        state.chain = {
          logs: orderedLogs,
          coverage,
          checkedAt: now,
          error: null,
          historyComplete: true,
          creationChecked: true,
          finalizedBlock: toBlock,
          finalizedTimestamp: tip.timestamp,
          evidenceFingerprint: this.evidenceFingerprint,
          snapshotSetHash: config.snapshotSetHash,
          generation: digest({
            coverage,
            exceptions,
            evidenceFingerprint: this.evidenceFingerprint,
            snapshotSetHash: config.snapshotSetHash,
          }),
        };
        state.bounties = view.bounties;
        state.history = view.history;
        state.exceptions = exceptions;
        state.eligibilityPolicy = {
          priorWallets: config.priorWallets,
          teamWallets: config.teamWallets,
          houseHunterWallets: config.houseHunterWallets || [],
        };
        state.evidenceCache = this.cache.state;
      });
    } catch (error) {
      const codes = [
        'WRONG_CHAIN',
        'CHAIN_STALE',
        'CODE_HASH_MISMATCH',
        'REORG_REBUILD_REQUIRED',
        'REORG_RETRY',
        'DEPLOYMENT_NOT_COVERED',
        'HISTORY_START_NOT_CREATION',
        'HISTORY_COUNT_MISMATCH',
        'EXCEPTIONS_FILE_INVALID',
        'RPC_LAGGING_RETRY',
      ];
      const code = codes.includes(error.message)
        ? error.message
        : 'RECONCILIATION_FAILED_RETRY';
      this.store.state.chain.error = code;
      try {
        this.store.transact((state) => {
          state.chain.error = code;
          state.evidenceCache = this.cache.state;
        });
      } catch {
        this.store.failed = true;
      }
    } finally {
      this.busy = false;
    }
  }
}
module.exports = { Indexer, iface, abi };
