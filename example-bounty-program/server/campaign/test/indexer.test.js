'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { Indexer, iface } = require('../indexer');
const { EvidenceCache, evidenceError } = require('../cache');
const { emptyExceptions } = require('../exceptions');
const { eligibility } = require('../predicates');
const { router } = require('../service');
const express = require('express');
const request = require('supertest');
const evidence = require('../evidence');
const { config: campaignConfig } = require('./helpers');
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
    ...campaignConfig(),
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
    log,
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
test('lagging finalized RPC skips fresh claims, ages normally and clears health notice on recovery', async (testContext) => {
  const data = fixture(testContext);
  await data.indexer.reconcile(now);
  const original = data.provider.getBlock;
  const oldChain = structuredClone(data.store.state.chain);
  data.provider.getBlock = async (blockTag) =>
    blockTag === 'finalized' ? { number: 15 } : original(blockTag);
  await data.indexer.reconcile(now + 10);
  assert.deepEqual(data.store.state.chain, {
    ...oldChain,
    lagNotice: { at: now + 10, toBlock: 15, coverageTo: 20 },
  });
  assert.equal(
    eligibility(data.config, data.store.state, 'Q3', creator, now + 10).code,
    'VERIFIED',
  );
  let clock = now + 10;
  const app = express();
  app.use(router(data.config, data.store, 'secret', () => clock));
  const fresh = await request(app).get('/health');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.lagging, true);
  clock = now + data.config.maxAgeSeconds + 1;
  await data.indexer.reconcile(clock);
  assert.equal(data.store.state.chain.checkedAt, now);
  assert.equal(data.store.state.chain.error, null);
  assert.equal(
    eligibility(data.config, data.store.state, 'Q3', creator, clock).code,
    'INDEX_NOT_READY_RETRY',
  );
  assert.equal((await request(app).get('/health')).status, 503);
  data.provider.getBlock = original;
  clock = now + 20;
  await data.indexer.reconcile(clock);
  assert.equal((await request(app).get('/health')).body.lagging, false);
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
test('terminal validation failures persist and never refetch under the same context', async (testContext) => {
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
    restored.check(
      'cid',
      `bounty:standard-v1:${fixtureData.indexer.evidenceFingerprint}:${fixtureData.config.snapshotSetHash}:80`,
      () => {
        calls++;
      },
    ),
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

for (const resolution of ['deny', 'refund']) {
  test(`duplicate scopes hold both until one is ${resolution === 'deny' ? 'denied' : 'refunded'}`, async (testContext) => {
    const data = fixture(testContext);
    data.logs.push(
      data.log(
        'BountyCreated',
        [1, creator, 'cid-2', 1, 80, 100, now + 200000],
        12,
      ),
    );
    data.contract.bountyCount = async () => 2n;
    data.contract.submissionCount = async (id) => (id === '0' ? 1n : 0n);
    await data.indexer.reconcile(now);
    assert.deepEqual(
      data.store.state.bounties.map((bounty) => bounty.duplicate),
      [true, true],
    );
    assert.equal(
      eligibility(data.config, data.store.state, 'Q3', creator, now).code,
      'DUPLICATE_SCOPE_REVIEW',
    );
    const exceptions = emptyExceptions();
    if (resolution === 'deny') {
      exceptions.denyBounties[data.store.state.bounties[1].key] = review();
      fs.writeFileSync(data.config.exceptionsFile, JSON.stringify(exceptions));
    } else {
      data.logs.push(data.log('BountyClosed', [1, creator, 100], 21));
      const original = data.provider.getBlock;
      data.provider.getBlock = async (blockTag) =>
        original(
          blockTag === 'latest' ? 24 : blockTag === 'finalized' ? 22 : blockTag,
        );
    }
    await data.indexer.reconcile(now + 10);
    assert.equal(data.store.state.chain.error, null);
    assert.deepEqual(
      data.store.state.bounties.map((bounty) => bounty.duplicate),
      [false, false],
    );
    assert.deepEqual(
      eligibility(data.config, data.store.state, 'Q3', creator, now + 10)
        .evidence,
      [data.store.state.bounties[0].key],
    );
  });
}
for (const contextChange of ['fingerprint', 'snapshots']) {
  for (const stage of ['inspectBounty', 'submission']) {
    test(`${contextChange} change revalidates terminal ${stage} cache entries`, async (testContext) => {
      const data = fixture(testContext);
      let attempts = 0;
      const success = data.validators[stage];
      data.validators[stage] = async () => {
        attempts++;
        throw evidenceError('INVALID_PACKAGE');
      };
      await data.indexer.reconcile(now);
      await data.indexer.reconcile(now + 1);
      assert.equal(attempts, 1);
      data.indexer = new Indexer(
        data.config,
        data.store,
        data.provider,
        data.validators,
        () => data.contract,
      );
      if (contextChange === 'fingerprint')
        data.indexer.evidenceFingerprint = 'new-installed-source-fingerprint';
      else data.config.snapshotSetHash = 'added-snapshot';
      data.validators[stage] = async () => {
        attempts++;
        return success();
      };
      await data.indexer.reconcile(now + 2);
      assert.equal(attempts, 2);
      assert.equal(data.store.state.bounties[0].evidence.ok, true);
      assert.equal(
        data.store.state.bounties[0].submissions[0].packageValid,
        true,
      );
      assert.equal(
        data.store.state.chain.evidenceFingerprint,
        data.indexer.evidenceFingerprint,
      );
      assert.equal(
        data.store.state.chain.snapshotSetHash,
        data.config.snapshotSetHash,
      );
    });
  }
}
test('module import failures are retried next cycle and logged once without details', async (testContext) => {
  const data = fixture(testContext);
  const logged = testContext.mock.method(console, 'warn', () => {});
  const provenance = require('./fixtures/provenance.json').find(
    (entry) => entry.bountyId === 9,
  );
  const evaluation = fs.readFileSync(
    path.join(__dirname, 'fixtures/sepolia-9-evaluation.zip'),
  );
  const rubric = fs.readFileSync(
    path.join(__dirname, 'fixtures/sepolia-9-rubric.json'),
  );
  data.config.approvedTemplates = await evidence.templateDigests();
  data.logs.push(
    data.log(
      'BountyCreated',
      [1, creator, 'cid-2', 1, 80, 100, now + 200000],
      12,
    ),
  );
  data.contract.bountyCount = async () => 2n;
  data.contract.submissionCount = async (id) => (id === '0' ? 1n : 0n);
  data.validators.fetchCid = async (cid) =>
    cid === provenance.rubricCid ? rubric : evaluation;
  let imports = 0;
  let failing = true;
  const moduleLoader = async () => {
    imports++;
    return failing
      ? import('./missing-private-deployment-module.mjs')
      : evidence.loadModules();
  };
  data.validators.inspectBounty = (bounty, config, fetcher) =>
    evidence.inspectBounty(bounty, config, fetcher, moduleLoader);
  await data.indexer.reconcile(now);
  assert.equal(logged.mock.calls.length, 1);
  assert.equal(imports, 2);
  assert.equal(
    data.store.state.bounties[0].evidenceError,
    'EVIDENCE_CHECK_FAILED_RETRY',
  );
  assert.doesNotMatch(
    JSON.stringify(logged.mock.calls[0].arguments),
    /private|module.mjs/,
  );
  assert.ok(
    Object.values(data.store.state.evidenceCache).every((record) =>
      Object.values(record.checks).every((check) => !check.terminal),
    ),
  );
  failing = false;
  await data.indexer.reconcile(now + 10);
  assert.equal(imports, 4);
  assert.equal(data.store.state.bounties[0].evidence.kind, 'workOrder');
  assert.equal(logged.mock.calls.length, 1);
});

test('classification-version contexts revalidate previously cached bounty and submission results', async (testContext) => {
  const data = fixture(testContext);
  await data.indexer.reconcile(now);
  data.store.transact((snapshot) => {
    for (const record of Object.values(snapshot.evidenceCache)) {
      record.checks = Object.fromEntries(Object.entries(record.checks).map(([context, result]) => [context.replace(':standard-v1:', ':'), result]));
    }
  });
  let bountyChecks = 0;
  let submissionChecks = 0;
  data.validators.inspectBounty = async () => {
    bountyChecks++;
    return { ok: true, kind: 'standard', scopeDigest: 'hash' };
  };
  data.validators.submission = async () => {
    submissionChecks++;
    return true;
  };
  data.indexer = new Indexer(data.config, data.store, data.provider, data.validators, () => data.contract);
  await data.indexer.reconcile(now + 1);
  assert.equal(data.store.state.chain.error, null);
  assert.equal(bountyChecks, 1);
  assert.equal(submissionChecks, 1);
  assert.equal(data.store.state.bounties[0].evidence.kind, 'standard');
  assert.equal(data.store.state.bounties[0].submissions[0].packageValid, true);
});
