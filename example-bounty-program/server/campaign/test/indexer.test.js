'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { Indexer, iface } = require('../indexer');
const { EvidenceCache, evidenceError } = require('../cache');
const { emptyExceptions } = require('../exceptions');
const {
  setup,
  review,
  escrow,
  creator,
  hunter,
  now,
  start,
} = require('./helpers');
function fixture(testContext) {
  const store = setup(testContext);
  store.transact((state) => {
    state.chain = { logs: [], coverage: null, error: 'NOT_INDEXED' };
    state.bounties = [];
  });
  const exceptionsFile = path.join(path.dirname(store.file), 'exceptions.json');
  fs.writeFileSync(exceptionsFile, JSON.stringify(emptyExceptions()));
  const config = {
    startAt: start,
    endAt: now + 1000,
    confirmations: 2,
    maxAgeSeconds: 3600,
    logChunkSize: 5,
    approvedTemplates: [],
    exceptionsFile,
    policyHash: 'policy',
    deployment: {
      chainId: 8453,
      address: escrow,
      fromBlock: 10,
      codeHash: ethers.keccak256('0x1234'),
    },
  };
  const log = (name, args, blockNumber = 10) => ({
    ...iface.encodeEventLog(iface.getEvent(name), args),
    address: escrow,
    blockNumber,
    blockHash: `hash-${blockNumber}`,
    index: 0,
    transactionHash: `tx-${blockNumber}`,
  });
  const logs = [
    log('BountyCreated', [0, creator, 'cid', 1, 80, 100, now + 200000]),
    log('SubmissionPrepared', [0, 0, hunter, escrow, 100, 'cid'], 11),
  ];
  let logCalls = 0;
  let creationChecks = 0;
  const provider = {
    getNetwork: async () => ({ chainId: 8453n }),
    getBlock: async (blockTag) => {
      const number =
        blockTag === 'latest' ? 22 : blockTag === 'finalized' ? 20 : blockTag;
      return { number, hash: `hash-${number}`, timestamp: now - 10 };
    },
    getCode: async (address, blockNumber) => {
      if (blockNumber < 10) {
        creationChecks++;
        return '0x';
      }
      return '0x1234';
    },
    getLogs: async ({ fromBlock, toBlock }) => {
      logCalls++;
      return logs.filter(
        (entry) =>
          entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock,
      );
    },
  };
  const contract = {
    bountyCount: async () => 1n,
    submissionCount: async () => 1n,
    getBounty: async () => ({ targetHunter: ethers.ZeroAddress }),
    getSubmission: async () => ({ hunterCid: 'hunter' }),
  };
  let evidenceCalls = 0;
  const validators = {
    inspectBounty: async () => {
      evidenceCalls++;
      return { ok: true, kind: 'workOrder', scopeDigest: 'hash' };
    },
    submission: async () => true,
  };
  const indexer = new Indexer(
    config,
    store,
    provider,
    validators,
    () => contract,
  );
  return {
    store,
    config,
    provider,
    contract,
    logs,
    indexer,
    validators,
    logCalls: () => logCalls,
    evidenceCalls: () => evidenceCalls,
    creationChecks: () => creationChecks,
  };
}
test('chunked finality reconciliation caches evidence and checks creation boundary only once', async (testContext) => {
  const fixtureData = fixture(testContext);
  await fixtureData.indexer.reconcile(now);
  assert.equal(fixtureData.store.state.chain.error, null);
  assert.equal(fixtureData.store.state.chain.finalizedBlock, 20);
  assert.equal(fixtureData.logCalls(), 3);
  await fixtureData.indexer.reconcile(now);
  assert.equal(fixtureData.logCalls(), 3);
  assert.equal(fixtureData.evidenceCalls(), 1);
  assert.equal(fixtureData.creationChecks(), 1);
});
test('lagging finalized RPC holds snapshot without wiping then recovers', async (testContext) => {
  const fixtureData = fixture(testContext);
  await fixtureData.indexer.reconcile(now);
  const original = fixtureData.provider.getBlock;
  fixtureData.provider.getBlock = async (blockTag) =>
    blockTag === 'finalized' ? { number: 15 } : original(blockTag);
  await fixtureData.indexer.reconcile(now);
  assert.equal(fixtureData.store.state.chain.error, 'RPC_LAGGING_RETRY');
  assert.equal(fixtureData.store.state.chain.logs.length, 2);
  assert.equal(fixtureData.store.state.chain.coverage.to, 20);
  fixtureData.provider.getBlock = original;
  await fixtureData.indexer.reconcile(now);
  assert.equal(fixtureData.store.state.chain.error, null);
});
test('only checkpoint hash mismatch triggers full rebuild', async (testContext) => {
  const fixtureData = fixture(testContext);
  await fixtureData.indexer.reconcile(now);
  const original = fixtureData.provider.getBlock;
  fixtureData.provider.getBlock = async (blockTag) => ({
    ...(await original(blockTag)),
    hash: blockTag === 20 ? 'replacement' : (await original(blockTag)).hash,
  });
  await fixtureData.indexer.reconcile(now);
  assert.equal(fixtureData.store.state.chain.error, 'REORG_REBUILD_REQUIRED');
  assert.equal(fixtureData.store.state.chain.logs.length, 0);
  fixtureData.provider.getBlock = original;
  await fixtureData.indexer.reconcile(now);
  assert.equal(fixtureData.store.state.chain.error, null);
  assert.equal(fixtureData.logCalls(), 6);
});
for (const [name, change, code] of [
  [
    'wrong chain',
    (fixtureData) => {
      fixtureData.provider.getNetwork = async () => ({ chainId: 84532n });
    },
    'WRONG_CHAIN',
  ],
  [
    'changed code',
    (fixtureData) => {
      fixtureData.provider.getCode = async () => '0x5678';
    },
    'CODE_HASH_MISMATCH',
  ],
  [
    'RPC outage',
    (fixtureData) => {
      fixtureData.provider.getBlock = async () => {
        throw new Error('secret RPC URL must never be returned');
      };
    },
    'RECONCILIATION_FAILED_RETRY',
  ],
  [
    'missing creation history',
    (fixtureData) => {
      fixtureData.contract.bountyCount = async () => 2n;
    },
    'HISTORY_COUNT_MISMATCH',
  ],
  [
    'missing submissions',
    (fixtureData) => {
      fixtureData.contract.submissionCount = async () => 2n;
    },
    'HISTORY_COUNT_MISMATCH',
  ],
  [
    'late deployment start',
    (fixtureData) => {
      fixtureData.provider.getCode = async () => '0x1234';
    },
    'HISTORY_START_NOT_CREATION',
  ],
  [
    'removed event',
    (fixtureData) => {
      fixtureData.logs[0].removed = true;
    },
    'REORG_RETRY',
  ],
  [
    'invalid exception JSON',
    (fixtureData) => {
      fs.writeFileSync(fixtureData.config.exceptionsFile, '{');
    },
    'EXCEPTIONS_FILE_INVALID',
  ],
  [
    'invalid exception schema',
    (fixtureData) => {
      fs.writeFileSync(fixtureData.config.exceptionsFile, '{"holdWallets":[]}');
    },
    'EXCEPTIONS_FILE_INVALID',
  ],
])
  test(name, async (testContext) => {
    const fixtureData = fixture(testContext);
    change(fixtureData);
    await fixtureData.indexer.reconcile(now);
    assert.equal(fixtureData.store.state.chain.error, code);
  });
test('exceptions are reread every reconcile', async (testContext) => {
  const fixtureData = fixture(testContext);
  await fixtureData.indexer.reconcile(now);
  const exceptions = emptyExceptions();
  exceptions.holdWallets[hunter] = review();
  fs.writeFileSync(
    fixtureData.config.exceptionsFile,
    JSON.stringify(exceptions),
  );
  await fixtureData.indexer.reconcile(now);
  assert.deepEqual(
    fixtureData.store.state.exceptions.holdWallets[hunter],
    review(),
  );
});
test('concurrent reconciliations publish once', async (testContext) => {
  const fixtureData = fixture(testContext);
  await Promise.all([
    fixtureData.indexer.reconcile(now),
    fixtureData.indexer.reconcile(now),
  ]);
  assert.equal(fixtureData.logCalls(), 3);
});
test('terminal validation failures persist and never refetch; changed policy can revalidate', async (testContext) => {
  const fixtureData = fixture(testContext);
  let calls = 0;
  fixtureData.validators.inspectBounty = async () => {
    calls++;
    throw evidenceError('RUBRIC_MISMATCH');
  };
  await fixtureData.indexer.reconcile(now);
  await fixtureData.indexer.reconcile(now + 10);
  assert.equal(calls, 1);
  assert.equal(
    fixtureData.store.state.bounties[0].evidenceError,
    'RUBRIC_MISMATCH',
  );
  const persisted = JSON.parse(
    fs.readFileSync(fixtureData.store.file),
  ).evidenceCache;
  const restored = new EvidenceCache(persisted);
  await assert.rejects(
    restored.check('cid', 'bounty:policy:80', () => {
      calls++;
    }),
    /RUBRIC_MISMATCH/,
  );
  assert.equal(calls, 1);
});
test('gateway backoff is per CID, exponential to one hour, and never cached as terminal', async () => {
  let timestamp = 0;
  let calls = 0;
  const cache = new EvidenceCache({}, () => timestamp);
  const fetcher = async () => {
    calls++;
    throw new Error('timeout');
  };
  for (const delay of [300, 600, 1200, 2400, 3600, 3600]) {
    await assert.rejects(cache.fetch('cid', fetcher), /GATEWAY_UNAVAILABLE/);
    assert.equal(cache.state.cid.fetchFailure.nextRetry, timestamp + delay);
    await assert.rejects(cache.fetch('cid', fetcher), /GATEWAY_UNAVAILABLE/);
    timestamp += delay;
  }
  assert.equal(calls, 6);
  assert.equal(
    (await cache.fetch('cid', async () => Buffer.from('recovered'))).toString(),
    'recovered',
  );
});
test('creation and preparation before campaign establish current-deployment prior activity', async (testContext) => {
  const fixtureData = fixture(testContext);
  fixtureData.config.startAt = now;
  await fixtureData.indexer.reconcile(now);
  assert.equal(fixtureData.store.state.history.creators[creator], true);
  assert.equal(fixtureData.store.state.history.hunters[hunter], true);
});
test('stale finalized timestamps hold the generation', async (testContext) => {
  const fixtureData = fixture(testContext);
  const original = fixtureData.provider.getBlock;
  fixtureData.provider.getBlock = async (blockTag) => ({
    ...(await original(blockTag)),
    timestamp: now - 4000,
  });
  await fixtureData.indexer.reconcile(now);
  assert.equal(fixtureData.store.state.chain.error, 'CHAIN_STALE');
});
