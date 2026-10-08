'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const path = require('path');
const {
  verify,
  router,
  trimDiagnostics,
  ATTEMPT_LIMIT,
  AUDIT_LIMIT,
} = require('../service');
const { eligibility } = require('../predicates');
const {
  validateConfig,
  loadConfig,
  QUESTS,
  DAY,
  digest,
} = require('../config');
const { Store } = require('../store');
const {
  applyIdentityReleases,
  validateExceptions,
  emptyExceptions,
} = require('../exceptions');
const { project } = require('../ledger');
const {
  config,
  state,
  bounty,
  setup,
  body,
  review,
  address,
  creator,
  hunter,
  hunterTwo,
  otherCreator,
  escrow,
  start,
  now,
} = require('./helpers');
for (const quest of ['Q3', 'Q4', 'Q5', 'Q6', 'Q14', 'Q15'])
  test(`${quest} automatically passes with empty exceptions`, () => {
    assert.equal(eligibility(config(), state(), quest, creator, now).ok, true);
  });
for (const quest of ['Q8', 'Q9', 'Q10'])
  test(`${quest} automatically passes with empty exceptions`, () => {
    const snapshot = state();
    snapshot.bounties[1] = bounty(
      2,
      start + 3 * DAY + 201,
      otherCreator,
      hunter,
    );
    assert.equal(eligibility(config(), snapshot, quest, hunter, now).ok, true);
  });
test('custom bounties pass XP, require cash exception, and cannot pass template quests', () => {
  const snapshot = state();
  snapshot.bounties.forEach((record) => {
    record.evidence.kind = 'custom';
  });
  for (const quest of ['Q3', 'Q5'])
    assert.equal(eligibility(config(), snapshot, quest, creator, now).ok, true);
  for (const quest of ['Q8', 'Q9'])
    assert.equal(eligibility(config(), snapshot, quest, hunter, now).ok, true);
  for (const quest of ['Q4', 'Q6'])
    assert.equal(
      eligibility(config(), snapshot, quest, creator, now).code,
      'CASH_ELIGIBILITY_REQUIRED',
    );
  for (const quest of ['Q14', 'Q15'])
    assert.equal(
      eligibility(config(), snapshot, quest, creator, now).code,
      'APPROVED_WORK_ORDER_REQUIRED',
    );
  snapshot.exceptions.allowCashBounties[snapshot.bounties[0].key] = review();
  assert.equal(eligibility(config(), snapshot, 'Q4', creator, now).ok, true);
  snapshot.exceptions.allowCashBounties[snapshot.bounties[1].key] = review();
  assert.equal(eligibility(config(), snapshot, 'Q6', creator, now).ok, true);
  assert.equal(eligibility(config(), snapshot, 'Q14', creator, now).ok, false);
  snapshot.bounties[1] = bounty(
    2,
    start + 3 * DAY + 201,
    otherCreator,
    hunter,
    'custom',
  );
  snapshot.exceptions.allowCashBounties = {};
  assert.equal(
    eligibility(config(), snapshot, 'Q10', hunter, now).code,
    'CASH_ELIGIBILITY_REQUIRED',
  );
  snapshot.bounties.forEach((record) => {
    snapshot.exceptions.allowCashBounties[record.key] = review();
  });
  assert.equal(eligibility(config(), snapshot, 'Q10', hunter, now).ok, true);
});
for (const [name, mutate, quest = 'Q3', claimant = creator] of [
  [
    'testnet',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.chainId = 84532;
      }),
  ],
  [
    'old bounty',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.createdAt = start - 1;
      }),
  ],
  [
    'other escrow',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.contract = address(8);
      }),
  ],
  [
    'funding too low',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.originalWei = '99';
      }),
  ],
  [
    'targeted',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.open = false;
      }),
  ],
  [
    'duplicate scope',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.duplicate = true;
      }),
  ],
  [
    'missing evidence',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.evidence.ok = false;
      }),
  ],
  [
    'prepared only',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.submissions[0].started = false;
      }),
    'Q8',
    hunter,
  ],
  [
    'invalid package',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.submissions[0].packageValid = false;
      }),
    'Q8',
    hunter,
  ],
  [
    'failed evaluation',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.submissions[0].passed = false;
      }),
    'Q8',
    hunter,
  ],
  [
    'repeat before 72 hours',
    (snapshot) => {
      snapshot.bounties[1].createdAt = start + 3 * DAY - 1;
    },
    'Q5',
  ],
  [
    'repeat before first payout',
    (snapshot) => {
      snapshot.bounties[0].payment.at = snapshot.bounties[1].createdAt + 1;
    },
    'Q5',
  ],
  [
    'same repeat paid hunter',
    (snapshot) => {
      snapshot.bounties[1].payment.winner = hunter;
    },
    'Q6',
  ],
  [
    'incomplete current coverage',
    (snapshot) => {
      snapshot.chain.historyComplete = false;
    },
    'Q4',
  ],
  [
    'RPC outage',
    (snapshot) => {
      snapshot.chain.error = 'RPC_OUTAGE';
    },
  ],
  [
    'stale snapshot',
    (snapshot) => {
      snapshot.chain.checkedAt = now - 3601;
    },
  ],
  [
    'reorg',
    (snapshot) => {
      snapshot.chain.error = 'REORG_REBUILD_REQUIRED';
    },
  ],
  [
    'late payment',
    (snapshot) =>
      snapshot.bounties.forEach((record) => {
        record.payment.at = start + 21 * DAY;
      }),
    'Q4',
  ],
])
  test(name, () => {
    const snapshot = state();
    mutate(snapshot);
    assert.equal(
      eligibility(config(), snapshot, quest, claimant, now).ok,
      false,
    );
  });
test('refunded posting still passes Q3/Q14; unpaid passes Q8 but not Q9', () => {
  const snapshot = state();
  snapshot.bounties.forEach((record) => {
    record.refunded = true;
  });
  for (const quest of ['Q3', 'Q14'])
    assert.equal(eligibility(config(), snapshot, quest, creator, now).ok, true);
  assert.equal(eligibility(config(), snapshot, 'Q4', creator, now).ok, false);
  snapshot.bounties.forEach((record) => {
    record.refunded = false;
    record.payment = null;
  });
  assert.equal(eligibility(config(), snapshot, 'Q8', hunter, now).ok, true);
  assert.equal(
    eligibility(config(), snapshot, 'Q9', hunter, now).code,
    'PAYMENT_NOT_RECEIVED_IN_WINDOW',
  );
});
test('window endpoints are inclusive and violations have a specific reason', () => {
  for (const hours of [4, 336, 3.99, 336.01]) {
    const snapshot = state();
    snapshot.bounties.forEach((record) => {
      record.deadline = record.createdAt + hours * 3600;
    });
    const result = eligibility(config(), snapshot, 'Q3', creator, now);
    assert.equal(result.ok, hours === 4 || hours === 336);
    if (!result.ok) assert.equal(result.code, 'SUBMISSION_WINDOW_OUT_OF_RANGE');
  }
});
test('current-deployment prehistory and optional prior-wallet snapshots exclude new claims', () => {
  for (const quest of ['Q4', 'Q6', 'Q10']) {
    const role = quest === 'Q10' ? 'hunters' : 'creators';
    const wallet = quest === 'Q10' ? hunter : creator;
    for (const useSnapshot of [false, true]) {
      const policy = config();
      const snapshot = state();
      if (useSnapshot) policy.priorWallets[role] = [wallet];
      else snapshot.history[role][wallet] = true;
      assert.equal(
        eligibility(policy, snapshot, quest, wallet, now).code,
        'PRE_CAMPAIGN_ACTIVITY',
      );
    }
  }
});
test('deny and wallet holds override cash exceptions; bound shared identity and self payment fail', () => {
  const snapshot = state();
  snapshot.bounties.forEach((record) => {
    snapshot.exceptions.denyBounties[record.key] = review();
    snapshot.exceptions.allowCashBounties[record.key] = review();
  });
  assert.equal(
    eligibility(config(), snapshot, 'Q4', creator, now).code,
    'BOUNTY_DENIED',
  );
  snapshot.exceptions.denyBounties = {};
  snapshot.exceptions.holdWallets[creator] = review();
  assert.equal(
    eligibility(config(), snapshot, 'Q3', creator, now).code,
    'WALLET_HELD_FOR_REVIEW',
  );
  snapshot.exceptions.holdWallets = {
    [hunter]: review(),
    [hunterTwo]: review(),
  };
  assert.equal(eligibility(config(), snapshot, 'Q4', creator, now).ok, false);
  snapshot.exceptions.holdWallets = {};
  snapshot.wallets = {
    [creator]: 'same-user',
    [hunter]: 'same-user',
    [hunterTwo]: 'same-user',
  };
  assert.equal(eligibility(config(), snapshot, 'Q4', creator, now).ok, false);
  snapshot.wallets = {};
  snapshot.bounties.forEach((record) => {
    record.payment.winner = creator;
  });
  assert.equal(eligibility(config(), snapshot, 'Q4', creator, now).ok, false);
});
test('repeat hunter requires different non-team second creator and 72h submission interval', () => {
  for (const change of [
    (snapshot) => {
      snapshot.bounties[1].creator = creator;
    },
    (snapshot) => {
      snapshot.bounties[1].submissions[0].submittedAt = start + 101;
    },
  ]) {
    const snapshot = state();
    snapshot.bounties[1] = bounty(
      2,
      start + 3 * DAY + 201,
      otherCreator,
      hunter,
    );
    change(snapshot);
    assert.equal(eligibility(config(), snapshot, 'Q10', hunter, now).ok, false);
  }
  const snapshot = state();
  snapshot.bounties[1] = bounty(2, start + 3 * DAY + 201, otherCreator, hunter);
  assert.equal(
    eligibility(
      { ...config(), teamWallets: [otherCreator] },
      snapshot,
      'Q10',
      hunter,
      now,
    ).ok,
    false,
  );
});
test('cutoff and grace verify timely activity only', () => {
  const policy = config();
  const snapshot = state();
  snapshot.chain.checkedAt = policy.endAt;
  assert.equal(
    eligibility(policy, snapshot, 'Q4', creator, policy.endAt).ok,
    true,
  );
  snapshot.chain.checkedAt = policy.claimEndAt - 1;
  assert.equal(
    eligibility(policy, snapshot, 'Q4', creator, policy.claimEndAt - 1).ok,
    true,
  );
  assert.equal(
    eligibility(policy, snapshot, 'Q4', creator, policy.claimEndAt).code,
    'CLAIM_WINDOW_CLOSED',
  );
  assert.equal(
    eligibility(policy, snapshot, 'Q3', creator, start - 1).code,
    'CAMPAIGN_NOT_STARTED',
  );
});
test('failed claims do not bind; mismatches fail only the claim; releases apply once', (testContext) => {
  const store = setup(testContext);
  const policy = config();
  assert.equal(verify(policy, store, body('Q3', address(50)), now).ok, false);
  assert.deepEqual(store.state.identities, {});
  assert.equal(
    verify(policy, store, body('Q3', creator, 'user', 'good'), now).ok,
    true,
  );
  assert.equal(
    verify(policy, store, body('Q3', hunter, 'user', 'swap'), now).code,
    'IDENTITY_REVIEW_REQUIRED',
  );
  assert.equal(
    verify(policy, store, body('Q3', creator, 'other', 'duplicate'), now).code,
    'IDENTITY_REVIEW_REQUIRED',
  );
  assert.equal(
    verify(policy, store, body('Q3', creator, 'user', 'again'), now).ok,
    true,
  );
  const release = {
    ...review(),
    userHash: digest([policy.id, 'user']),
    wallet: creator,
  };
  applyIdentityReleases(store, [release]);
  assert.deepEqual(store.state.identities, {});
  assert.equal(
    verify(policy, store, body('Q8', hunter, 'user', 'new-wallet'), now).ok,
    true,
  );
  applyIdentityReleases(store, [release]);
  assert.equal(store.state.identities[release.userHash], hunter);
});
test('concurrent duplicates compact to one durable verified milestone and are re-evaluated', async (testContext) => {
  const store = setup(testContext);
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => verify(config(), store, body(), now)),
    ),
  );
  assert.ok(outcomes.every((result) => result.ok));
  assert.equal(Object.keys(store.state.verifiedClaims).length, 1);
  assert.equal(Object.keys(store.state.attempts).length, 0);
  store.transact((snapshot) => {
    snapshot.chain.error = 'REORG';
  });
  assert.equal(verify(config(), store, body(), now).ok, false);
});
test('retention evicts oldest unsuccessful entries and never blocks new verified claims', (testContext) => {
  const store = setup(testContext);
  for (let index = 0; index <= ATTEMPT_LIMIT; index++)
    store.state.attempts[`request-${index}`] = { code: 'PENDING', at: index };
  for (let index = 0; index <= AUDIT_LIMIT; index++)
    store.state.audit.push({ code: 'PENDING', at: index });
  trimDiagnostics(store.state, store);
  assert.equal(store.state.attempts['request-0'], undefined);
  assert.equal(store.state.audit[0].at, 1);
  assert.equal(verify(config(), store, body(), now).ok, true);
  assert.equal(Object.keys(store.state.attempts).length, ATTEMPT_LIMIT);
  assert.equal(store.state.audit.length, AUDIT_LIMIT);
});
test('restart preserves successful identities and rejects eligibility policy changes', (testContext) => {
  const store = setup(testContext);
  verify(config(), store, body(), now);
  store.close();
  const restarted = new Store(path.dirname(store.file), 'policy');
  assert.equal(restarted.state.wallets[creator], digest([config().id, 'user']));
  restarted.close();
  assert.throws(
    () => new Store(path.dirname(store.file), 'different'),
    /mismatch/,
  );
});
test('HTTP responses are plain sentences with codes; auth and 8kb parser fail closed', async (testContext) => {
  const store = setup(testContext);
  const secret = 'x'.repeat(32);
  const app = express();
  app.use(router(config(), store, secret, () => now));
  const denied = await request(app).post('/verify').send(body());
  assert.equal(denied.status, 400);
  assert.match(denied.body.message, /\[AUTHENTICATION_FAILED\]$/);
  const success = await request(app)
    .post('/verify')
    .set('X-Api-Key', secret)
    .send(body());
  assert.equal(success.status, 200);
  assert.equal(
    success.body.message,
    'Verified: you completed this campaign milestone. [VERIFIED]',
  );
  for (const payload of ['{', JSON.stringify({ huge: 'x'.repeat(9000) })]) {
    const result = await request(app)
      .post('/verify')
      .set('X-Api-Key', secret)
      .set('Content-Type', 'application/json')
      .send(payload);
    assert.equal(result.status, 400);
    assert.match(result.body.message, /\[INVALID_REQUEST\]$/);
  }
});
test('wallet must come from authenticated accounts; zero and arbitrary pasted wallets fail', (testContext) => {
  const store = setup(testContext);
  const claim = body();
  delete claim.accounts.wallet;
  claim.wallet = creator;
  assert.equal(
    verify(config(), store, claim, now).code,
    'AUTHENTICATED_WALLET_REQUIRED',
  );
  assert.equal(
    verify(config(), store, body('Q3', address(0)), now).code,
    'AUTHENTICATED_WALLET_REQUIRED',
  );
});
test('storage failure cannot return success or approve a later request', (testContext) => {
  const store = setup(testContext);
  store.writeAtomic = () => {
    throw new Error('disk failure');
  };
  assert.throws(() => verify(config(), store, body(), now));
  assert.equal(
    verify(config(), store, body(), now).code,
    'VERIFICATION_UNAVAILABLE_RETRY',
  );
});
test('snapshot additions preserve policy and existing state while updating evidence policy', (testContext) => {
  assert.equal(loadConfig({}), null);
  const sample = require('../config.example.json');
  assert.throws(() => validateConfig(sample, 'x'.repeat(32)));
  const input = {
    ...sample,
    communityId: 'community',
    subdomain: 'verdikta',
    start: '2026-10-01T00:00:00Z',
    minimumWei: '100',
    teamWalletsReviewed: true,
    quests: Object.fromEntries(
      QUESTS.map((quest, index) => [
        quest,
        `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      ]),
    ),
  };
  const original = validateConfig(input, 'x'.repeat(32));
  const operational = validateConfig(
    {
      ...input,
      stateDirectory: '/tmp/changed',
      exceptionsFile: '/tmp/other',
      pollSeconds: 30,
      maxAgeSeconds: 7200,
      logChunkSize: 1000,
      confirmations: 30,
      note: 'free text',
    },
    'y'.repeat(32),
  );
  assert.equal(original.policyHash, operational.policyHash);
  const { snapshotDigest } = require('../config');
  const snapshot = structuredClone(input.approvedTemplates[0]);
  snapshot.version = 'reviewed-older-version';
  snapshot.sha256 = snapshotDigest(snapshot);
  const added = validateConfig(
    { ...input, approvedTemplates: [...input.approvedTemplates, snapshot] },
    'x'.repeat(32),
  );
  assert.notEqual(original.snapshotSetHash, added.snapshotSetHash);
  assert.equal(original.policyHash, added.policyHash);
  assert.equal(
    added.snapshotSetHash,
    validateConfig(
      { ...input, approvedTemplates: [...added.approvedTemplates].reverse() },
      'x'.repeat(32),
    ).snapshotSetHash,
  );
  const store = setup(testContext);
  const directory = path.join(path.dirname(store.file), 'snapshot-addition');
  const originalStore = new Store(directory, original.policyHash, {
    approvedSnapshotHashes: original.approvedTemplates.map(
      (entry) => entry.sha256,
    ),
  });
  originalStore.transact(() => {});
  originalStore.transactClaims((state) => {
    state.wallets[creator] = 'preserved-binding';
  });
  originalStore.close();
  const reopened = new Store(directory, added.policyHash, {
    approvedSnapshotHashes: added.approvedTemplates.map(
      (entry) => entry.sha256,
    ),
  });
  assert.equal(reopened.state.wallets[creator], 'preserved-binding');
  reopened.transact(() => {});
  reopened.close();
  assert.throws(
    () =>
      new Store(directory, original.policyHash, {
        approvedSnapshotHashes: original.approvedTemplates.map(
          (entry) => entry.sha256,
        ),
      }),
    /snapshot removal/,
  );
  assert.notEqual(
    original.policyHash,
    validateConfig({ ...input, minimumWei: '101' }, 'x'.repeat(32)).policyHash,
  );
  delete input.minimumWindowHours;
  delete input.maximumWindowHours;
  assert.equal(validateConfig(input, 'x'.repeat(32)).minimumWindowHours, 4);
  assert.equal(validateConfig(input, 'x'.repeat(32)).maximumWindowHours, 336);
});
test('exceptions reject malformed metadata, foreign bounty keys and wallet addresses', () => {
  for (const changes of [
    { denyBounties: { foreign: review() } },
    { holdWallets: { invalid: review() } },
    { identityReleases: [{ userHash: 'bad', wallet: creator, ...review() }] },
  ]) {
    assert.throws(
      () =>
        validateExceptions(
          { ...emptyExceptions(), ...changes },
          config().deployment,
        ),
      /EXCEPTIONS_FILE_INVALID/,
    );
  }
});
test('creator-approved winners pass Q8/Q9, while deferred credit waits for withdrawal', () => {
  const logs = [];
  const emit = (name, args, timestamp = start + 100, transaction = 'settle') =>
    logs.push({ name, args, at: timestamp, tx: transaction, contract: escrow });
  emit(
    'BountyCreated',
    {
      bountyId: '1',
      creator,
      payoutWei: '100',
      evaluationCid: 'cid',
      threshold: '80',
      submissionDeadline: String(start + DAY),
    },
    start,
  );
  emit(
    'SubmissionPrepared',
    { bountyId: '1', submissionId: '0', hunter },
    start + 10,
    'prepare',
  );
  emit('CreatorApproved', {
    bountyId: '1',
    submissionId: '0',
    hunter,
    amountPaid: '100',
  });
  emit('PayoutSent', { bountyId: '1', winner: hunter, amountWei: '100' });
  const snapshot = state();
  const apply = () => {
    snapshot.bounties = project(logs, start).bounties;
    snapshot.bounties[0].evidence = {
      ok: true,
      kind: 'workOrder',
      scopeDigest: 'scope',
    };
    snapshot.bounties[0].open = true;
    snapshot.bounties[0].submissions[0].packageValid = true;
  };
  apply();
  for (const quest of ['Q8', 'Q9'])
    assert.equal(eligibility(config(), snapshot, quest, hunter, now).ok, true);
  emit('PaymentDeferred', { to: hunter, amount: '100' });
  apply();
  assert.equal(eligibility(config(), snapshot, 'Q9', hunter, now).ok, false);
  emit(
    'Withdrawn',
    { account: hunter, amount: '100' },
    start + 500,
    'withdraw',
  );
  apply();
  assert.equal(eligibility(config(), snapshot, 'Q9', hunter, now).ok, true);
  assert.equal(snapshot.bounties[0].originalWei, '100');
});
test('different numeric IDs with identical scope do not satisfy repeat eligibility', () => {
  const snapshot = state();
  snapshot.bounties[1].evidence.scopeDigest =
    snapshot.bounties[0].evidence.scopeDigest;
  assert.equal(eligibility(config(), snapshot, 'Q5', creator, now).ok, false);
  snapshot.bounties[0].duplicate = true;
  snapshot.bounties[1].duplicate = true;
  assert.equal(
    eligibility(config(), snapshot, 'Q3', creator, now).code,
    'DUPLICATE_SCOPE_REVIEW',
  );
});
test('inspection exports successful cash evidence and identity-release user hashes', (testContext) => {
  const store = setup(testContext);
  assert.equal(verify(config(), store, body('Q4'), now).ok, true);
  const exported = require('../../scripts/campaign-inspect').inspect(
    store.file,
  );
  assert.equal(exported.verifiedCashClaims.length, 1);
  assert.equal(
    exported.verifiedCashClaims[0].snapshotSetHash,
    config().snapshotSetHash,
  );
  assert.deepEqual(exported.verifiedCashClaims[0].evidence, [
    store.state.bounties[0].key,
  ]);
  assert.equal(exported.identities[0].userHash, digest([config().id, 'user']));
  assert.equal(exported.identities[0].wallet, creator);
});
