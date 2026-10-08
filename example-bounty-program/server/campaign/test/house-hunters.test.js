'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getAddress } = require('ethers');
const {
  validateConfig,
  digest,
  QUESTS,
  CASH_QUESTS,
  DAY,
} = require('../config');
const { eligibility } = require('../predicates');
const { verify } = require('../service');
const { project } = require('../ledger');
const { Store } = require('../store');
const { inspect } = require('../../scripts/campaign-inspect');
const {
  config,
  state,
  bounty,
  setup,
  body,
  review,
  creator,
  hunter,
  otherCreator,
  escrow,
  start,
  now,
} = require('./helpers');
const house = `0x${'ab'.repeat(20)}`;
const otherTeam = `0x${'cd'.repeat(20)}`;
function housePolicy() {
  return {
    ...config(),
    teamWallets: [house, otherTeam],
    houseHunterWallets: [house],
  };
}
function houseState() {
  const snapshot = state();
  snapshot.bounties = [
    bounty(1, start, creator, house),
    bounty(2, start + 3 * DAY + 201, creator, house),
  ];
  return snapshot;
}
function configInput() {
  return {
    ...require('../config.example.json'),
    communityId: 'community',
    subdomain: 'verdikta',
    start: '2026-10-01T00:00:00Z',
    minimumWei: '100',
    teamWalletsReviewed: true,
    teamWallets: [house, otherTeam],
    quests: Object.fromEntries(
      QUESTS.map((quest, index) => [
        quest,
        `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      ]),
    ),
  };
}
for (const quest of ['Q4', 'Q5', 'Q6', 'Q15']) {
  test(`${quest} accepts a non-team creator's paid house-hunter evidence`, () => {
    const snapshot = houseState();
    const result = eligibility(housePolicy(), snapshot, quest, creator, now);
    assert.equal(result.code, 'VERIFIED');
    assert.equal(result.creatorCompletionKind, 'house-assisted');
    const supporting =
      quest === 'Q6' ? snapshot.bounties : [snapshot.bounties[0]];
    assert.deepEqual(
      result.houseAssistedEvidence,
      supporting.map((record) => ({
        bountyKey: record.key,
        hunter: house,
        amountWei: '100',
        paidAt: record.payment.at,
        paymentTx: record.payment.tx,
      })),
    );
  });
}
test('house permission is opt-in and never extends to all team hunters', () => {
  for (const houseHunterWallets of [undefined, [], [otherTeam]]) {
    const policy = { ...housePolicy(), houseHunterWallets };
    assert.equal(
      eligibility(policy, houseState(), 'Q4', creator, now).code,
      'PAYMENT_NOT_RECEIVED_IN_WINDOW',
    );
  }
});
test('Q6 still requires different ordinary winners but allows mixed house and ordinary fulfillment', () => {
  const snapshot = houseState();
  for (const record of snapshot.bounties) record.payment.winner = hunter;
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q6', creator, now).ok,
    false,
  );
  snapshot.bounties[0].payment.winner = house;
  const result = eligibility(housePolicy(), snapshot, 'Q6', creator, now);
  assert.equal(result.code, 'VERIFIED');
  assert.equal(result.houseAssistedEvidence.length, 1);
});
test('every API quest excludes house and other team claimants, including creator cash', (testContext) => {
  const store = setup(testContext);
  store.transact((snapshot) => Object.assign(snapshot, houseState()));
  for (const wallet of [house, otherTeam]) {
    store.transact((snapshot) => {
      for (const record of snapshot.bounties) record.creator = wallet;
    });
    for (const quest of QUESTS) {
      assert.equal(
        verify(
          housePolicy(),
          store,
          body(quest, wallet, wallet, `${wallet}-${quest}`),
          now,
        ).code,
        'TEAM_WALLET_EXCLUDED',
      );
    }
    assert.equal(store.state.wallets[wallet], undefined);
  }
});
for (const [name, mutate] of [
  [
    'self payment',
    (snapshot) => {
      snapshot.bounties.forEach((record) => {
        record.payment.winner = creator;
      });
    },
  ],
  [
    'held house hunter',
    (snapshot) => {
      snapshot.exceptions.holdWallets[house] = review();
    },
  ],
  [
    'held creator',
    (snapshot) => {
      snapshot.exceptions.holdWallets[creator] = review();
    },
  ],
  [
    'known shared identity',
    (snapshot) => {
      snapshot.wallets[creator] = 'same-user';
      snapshot.wallets[house] = 'same-user';
    },
  ],
  [
    'denied bounties',
    (snapshot) => {
      snapshot.bounties.forEach((record) => {
        snapshot.exceptions.denyBounties[record.key] = review();
      });
    },
  ],
  [
    'duplicate scopes',
    (snapshot) => {
      snapshot.bounties.forEach((record) => {
        record.duplicate = true;
      });
    },
  ],
  [
    'refunds',
    (snapshot) => {
      snapshot.bounties.forEach((record) => {
        record.refunded = true;
      });
    },
  ],
  [
    'pending payout',
    (snapshot) => {
      snapshot.bounties.forEach((record) => {
        record.payment.at = null;
      });
    },
  ],
  [
    'zero payment',
    (snapshot) => {
      snapshot.bounties.forEach((record) => {
        record.payment.amount = '0';
      });
    },
  ],
  [
    'unfinalized index',
    (snapshot) => {
      snapshot.chain.error = 'INDEX_NOT_READY';
    },
  ],
]) {
  test(`house assistance does not bypass ${name}`, () => {
    const snapshot = houseState();
    mutate(snapshot);
    for (const quest of ['Q4', 'Q5', 'Q6', 'Q15'])
      assert.equal(
        eligibility(housePolicy(), snapshot, quest, creator, now).ok,
        false,
      );
  });
}
for (const [name, mutate] of [
  [
    'same bounty',
    (snapshot) => {
      snapshot.bounties[1].key = snapshot.bounties[0].key;
    },
  ],
  [
    'same scope',
    (snapshot) => {
      snapshot.bounties[1].evidence.scopeDigest =
        snapshot.bounties[0].evidence.scopeDigest;
    },
  ],
  [
    'short creation gap',
    (snapshot) => {
      snapshot.bounties[1].createdAt = start + 3 * DAY - 1;
    },
  ],
  [
    'second created before first receipt',
    (snapshot) => {
      snapshot.bounties[0].payment.at = snapshot.bounties[1].createdAt;
    },
  ],
  [
    'insufficient original funding',
    (snapshot) => {
      snapshot.bounties[0].originalWei = '99';
    },
  ],
  [
    'invalid evidence',
    (snapshot) => {
      snapshot.bounties[0].evidence.ok = false;
    },
  ],
  [
    'out-of-range submission window',
    (snapshot) => {
      snapshot.bounties[0].deadline = start + 4 * 3600 - 1;
    },
  ],
  [
    'payment after campaign cutoff',
    (snapshot) => {
      snapshot.bounties[1].payment.at = housePolicy().endAt;
    },
  ],
  [
    'pre-campaign creator activity',
    (snapshot) => {
      snapshot.history.creators[creator] = true;
    },
  ],
  [
    'stale chain snapshot',
    (snapshot) => {
      snapshot.chain.checkedAt = now - housePolicy().maxAgeSeconds - 1;
    },
  ],
]) {
  test(`same-house Q6 preserves ${name} rejection`, () => {
    const snapshot = houseState();
    mutate(snapshot);
    assert.equal(
      eligibility(housePolicy(), snapshot, 'Q6', creator, now).ok,
      false,
    );
  });
}
test('custom house work keeps cash exceptions and template requirements', () => {
  const snapshot = houseState();
  snapshot.bounties.forEach((record) => {
    record.evidence.kind = 'custom';
  });
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q5', creator, now).code,
    'VERIFIED',
  );
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q4', creator, now).code,
    'CASH_ELIGIBILITY_REQUIRED',
  );
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q6', creator, now).code,
    'CASH_ELIGIBILITY_REQUIRED',
  );
  snapshot.exceptions.allowCashBounties[snapshot.bounties[0].key] = review();
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q4', creator, now).code,
    'VERIFIED',
  );
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q6', creator, now).ok,
    false,
  );
  snapshot.exceptions.allowCashBounties[snapshot.bounties[1].key] = review();
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q6', creator, now).code,
    'VERIFIED',
  );
  for (const quest of ['Q14', 'Q15'])
    assert.equal(
      eligibility(housePolicy(), snapshot, quest, creator, now).code,
      'APPROVED_WORK_ORDER_REQUIRED',
    );
});
test('deferred house payout earns Q4 and Q5 only after timely withdrawal before the second creation', () => {
  const base = houseState();
  const created = (record) => ({
    name: 'BountyCreated',
    at: record.createdAt,
    tx: `created-${record.id}`,
    contract: escrow,
    args: {
      bountyId: record.id,
      creator,
      payoutWei: '100',
      evaluationCid: 'cid',
      threshold: '80',
      submissionDeadline: String(record.deadline),
    },
  });
  const logs = [
    created(base.bounties[0]),
    {
      name: 'PayoutSent',
      args: { bountyId: '1', winner: house, amountWei: '100' },
      at: start + 200,
      tx: 'award',
      contract: escrow,
    },
    {
      name: 'PaymentDeferred',
      args: { to: house, amount: '100' },
      at: start + 200,
      tx: 'award',
      contract: escrow,
    },
    created(base.bounties[1]),
  ];
  const apply = () => {
    const snapshot = houseState();
    snapshot.bounties = project(
      [...logs].sort((first, second) => first.at - second.at),
      start,
    ).bounties;
    snapshot.bounties.forEach((record, index) => {
      record.open = true;
      record.evidence = base.bounties[index].evidence;
    });
    return snapshot;
  };
  for (const quest of ['Q4', 'Q5'])
    assert.equal(
      eligibility(housePolicy(), apply(), quest, creator, now).ok,
      false,
    );
  const withdrawal = {
    name: 'Withdrawn',
    args: { account: house, amount: '100' },
    at: start + 500,
    tx: 'withdraw',
    contract: escrow,
  };
  logs.push(withdrawal);
  for (const quest of ['Q4', 'Q5']) {
    const result = eligibility(housePolicy(), apply(), quest, creator, now);
    assert.equal(result.code, 'VERIFIED');
    assert.equal(result.houseAssistedEvidence[0].paymentTx, 'withdraw');
    assert.equal(result.houseAssistedEvidence[0].paidAt, start + 500);
  }
  withdrawal.at = base.bounties[1].createdAt;
  assert.equal(
    eligibility(housePolicy(), apply(), 'Q5', creator, now).ok,
    false,
  );
  withdrawal.at = housePolicy().endAt;
  assert.equal(
    eligibility(housePolicy(), apply(), 'Q4', creator, now).ok,
    false,
  );
});
test('external hunters retain Q9 on team custom starters and Q10 with a later different non-team creator', () => {
  const snapshot = state();
  snapshot.bounties = [bounty(1, start, house, hunter, 'custom')];
  snapshot.history.hunters[hunter] = true;
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q9', hunter, now).code,
    'VERIFIED',
  );
  delete snapshot.history.hunters[hunter];
  snapshot.bounties[0].evidence.kind = 'workOrder';
  snapshot.bounties.push(
    bounty(2, start + 3 * DAY + 201, otherCreator, hunter),
  );
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q10', hunter, now).code,
    'VERIFIED',
  );
  snapshot.bounties[1].creator = otherTeam;
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q10', hunter, now).ok,
    false,
  );
  snapshot.bounties[1].creator = otherCreator;
  snapshot.history.hunters[hunter] = true;
  assert.equal(
    eligibility(housePolicy(), snapshot, 'Q10', hunter, now).code,
    'PRE_CAMPAIGN_ACTIVITY',
  );
});
test('allowlist normalization, subset and uniqueness validation preserve disabled policy compatibility', (testContext) => {
  const input = configInput();
  delete input.houseHunterWallets;
  const original = validateConfig(input, 'x'.repeat(32));
  const empty = validateConfig(
    { ...input, houseHunterWallets: [] },
    'x'.repeat(32),
  );
  const oldFields = [
    'id',
    'communityId',
    'subdomain',
    'start',
    'minimumWei',
    'minimumWindowHours',
    'maximumWindowHours',
    'teamWallets',
    'quests',
    'deployment',
    'priorWallets',
  ];
  assert.equal(
    original.policyHash,
    digest(
      Object.fromEntries(oldFields.map((field) => [field, original[field]])),
    ),
  );
  assert.equal(original.policyHash, empty.policyHash);
  const enabled = validateConfig(
    { ...input, houseHunterWallets: [getAddress(house)] },
    'x'.repeat(32),
  );
  assert.deepEqual(enabled.houseHunterWallets, [house]);
  assert.notEqual(enabled.policyHash, original.policyHash);
  for (const allowlist of [
    [hunter],
    [house, getAddress(house)],
    'invalid',
    ['invalid-address'],
  ])
    assert.throws(() =>
      validateConfig(
        { ...input, houseHunterWallets: allowlist },
        'x'.repeat(32),
      ),
    );
  const store = setup(testContext);
  const directory = path.join(path.dirname(store.file), 'house-policy');
  const existing = new Store(directory, original.policyHash);
  existing.transact(() => {});
  existing.transactClaims((snapshot) => {
    snapshot.wallets[creator] = 'binding';
  });
  existing.close();
  const compatible = new Store(directory, empty.policyHash);
  assert.equal(compatible.state.wallets[creator], 'binding');
  compatible.close();
  assert.throws(() => new Store(directory, enabled.policyHash), /mismatch/);
});
test('inspection preserves house-assisted payment evidence, ordinary claims and Q9 reward candidates', (testContext) => {
  const store = setup(testContext);
  store.transact((snapshot) => {
    Object.assign(snapshot, houseState());
    snapshot.eligibilityPolicy = housePolicy();
  });
  for (const quest of ['Q4', 'Q5', 'Q6', 'Q15'])
    assert.equal(
      verify(
        housePolicy(),
        store,
        body(quest, creator, 'creator-user', quest),
        now,
      ).code,
      'VERIFIED',
    );
  store.transact((snapshot) => {
    // Later ledger changes must not erase the successful house receipts in claims.
    snapshot.bounties = [
      bounty(3, start, house, hunter, 'custom'),
      bounty(4, start, otherCreator, hunter),
    ];
    snapshot.history.hunters[hunter] = true;
  });
  assert.equal(
    verify(
      housePolicy(),
      store,
      body('Q9', hunter, 'returning-hunter', 'q9'),
      now,
    ).code,
    'VERIFIED',
  );
  assert.equal(
    verify(
      housePolicy(),
      store,
      body('Q4', otherCreator, 'organic-creator', 'organic-q4'),
      now,
    ).code,
    'VERIFIED',
  );
  assert.equal(CASH_QUESTS.includes('Q9'), false);
  const exported = inspect(store.file);
  assert.deepEqual(exported.houseHunterWallets, [house]);
  assert.equal(exported.verifiedHouseAssistedCreatorClaims.length, 4);
  const assisted = exported.verifiedHouseAssistedCreatorClaims.find(
    (claim) => claim.quest === 'Q6',
  );
  assert.deepEqual(
    assisted.evidence,
    houseState().bounties.map((record) => record.key),
  );
  assert.equal(assisted.houseAssistedEvidence.length, 2);
  assert.equal(assisted.houseAssistedEvidence[0].hunter, house);
  assert.equal(assisted.houseAssistedEvidence[0].paymentTx, 'paid-1');
  assert.equal(
    exported.verifiedClaims.find((claim) => claim.wallet === otherCreator)
      .creatorCompletionKind,
    'organic',
  );
  assert.equal(
    exported.verifiedCashClaims.some((claim) => claim.quest === 'Q9'),
    false,
  );
  assert.equal(
    exported.verifiedCashCandidateClaims.filter((claim) => claim.quest === 'Q9')
      .length,
    1,
  );
  assert.ok(
    exported.verifiedCashCandidateClaims.every(
      (claim) => claim.rewardStatus === 'candidate-only',
    ),
  );
  assert.deepEqual(
    new Set(exported.verifiedCashCandidateClaims.map((claim) => claim.quest)),
    new Set(['Q4', 'Q6', 'Q9']),
  );
  store.close();
  const restarted = new Store(path.dirname(store.file), 'policy');
  testContext.after(() => restarted.close());
  assert.equal(
    Object.values(restarted.state.verifiedClaims).find(
      (claim) => claim.quest === 'Q6',
    ).houseAssistedEvidence.length,
    2,
  );
});
