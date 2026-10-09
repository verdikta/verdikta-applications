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
const agent = `0x${'ab'.repeat(20)}`;
const otherTeam = `0x${'cd'.repeat(20)}`;
function agentPolicy() {
  return {
    ...config(),
    teamWallets: [agent, otherTeam],
    verdiktaAgentWallets: [agent],
  };
}
function agentState() {
  const snapshot = state();
  snapshot.bounties = [
    bounty(1, start, creator, agent),
    bounty(2, start + 3 * DAY + 201, creator, agent),
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
    teamWallets: [agent, otherTeam],
    quests: Object.fromEntries(
      QUESTS.map((quest, index) => [
        quest,
        `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      ]),
    ),
  };
}
for (const quest of ['Q4', 'Q5', 'Q6', 'Q15']) {
  test(`${quest} accepts a non-team creator's paid agent-hunter evidence`, () => {
    const snapshot = agentState();
    const result = eligibility(agentPolicy(), snapshot, quest, creator, now);
    assert.equal(result.code, 'VERIFIED');
    assert.equal(result.creatorCompletionKind, 'agent-assisted');
    const supporting =
      quest === 'Q6' ? snapshot.bounties : [snapshot.bounties[0]];
    assert.deepEqual(
      result.agentAssistedEvidence,
      supporting.map((record) => ({
        bountyKey: record.key,
        hunter: agent,
        amountWei: '100',
        paidAt: record.payment.at,
        paymentTx: record.payment.tx,
      })),
    );
  });
}
test('agent permission is opt-in and never extends to all team hunters', () => {
  for (const verdiktaAgentWallets of [undefined, [], [otherTeam]]) {
    const policy = { ...agentPolicy(), verdiktaAgentWallets };
    assert.equal(
      eligibility(policy, agentState(), 'Q4', creator, now).code,
      'PAYMENT_NOT_RECEIVED_IN_WINDOW',
    );
  }
});
test('Q6 still requires different ordinary winners but allows mixed agent and ordinary fulfillment', () => {
  const snapshot = agentState();
  for (const record of snapshot.bounties) record.payment.winner = hunter;
  assert.equal(
    eligibility(agentPolicy(), snapshot, 'Q6', creator, now).ok,
    false,
  );
  snapshot.bounties[0].payment.winner = agent;
  const result = eligibility(agentPolicy(), snapshot, 'Q6', creator, now);
  assert.equal(result.code, 'VERIFIED');
  assert.equal(result.agentAssistedEvidence.length, 1);
});
test('every API quest excludes agent and other team claimants, including creator cash', (testContext) => {
  const store = setup(testContext);
  store.transact((snapshot) => Object.assign(snapshot, agentState()));
  for (const wallet of [agent, otherTeam]) {
    store.transact((snapshot) => {
      for (const record of snapshot.bounties) record.creator = wallet;
    });
    for (const quest of QUESTS) {
      assert.equal(
        verify(
          agentPolicy(),
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
    'held Verdikta agent',
    (snapshot) => {
      snapshot.exceptions.holdWallets[agent] = review();
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
      snapshot.wallets[agent] = 'same-user';
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
  test(`agent assistance does not bypass ${name}`, () => {
    const snapshot = agentState();
    mutate(snapshot);
    for (const quest of ['Q4', 'Q5', 'Q6', 'Q15'])
      assert.equal(
        eligibility(agentPolicy(), snapshot, quest, creator, now).ok,
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
      snapshot.bounties[1].payment.at = agentPolicy().endAt;
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
      snapshot.chain.checkedAt = now - agentPolicy().maxAgeSeconds - 1;
    },
  ],
]) {
  test(`same-agent Q6 preserves ${name} rejection`, () => {
    const snapshot = agentState();
    mutate(snapshot);
    assert.equal(
      eligibility(agentPolicy(), snapshot, 'Q6', creator, now).ok,
      false,
    );
  });
}
test('standard Verdikta agent work automatically qualifies for creator cash but not templates', () => {
  const snapshot = agentState();
  snapshot.bounties.forEach((record) => {
    record.evidence.kind = 'standard';
  });
  for (const quest of ['Q4', 'Q5', 'Q6']) {
    const result = eligibility(agentPolicy(), snapshot, quest, creator, now);
    assert.equal(result.code, 'VERIFIED');
    assert.equal(result.creatorCompletionKind, 'agent-assisted');
  }
  for (const quest of ['Q14', 'Q15'])
    assert.equal(eligibility(agentPolicy(), snapshot, quest, creator, now).code, 'APPROVED_WORK_ORDER_REQUIRED');
});
test('deferred Verdikta agent payout earns Q4 and Q5 only after timely withdrawal before the second creation', () => {
  const base = agentState();
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
      args: { bountyId: '1', winner: agent, amountWei: '100' },
      at: start + 200,
      tx: 'award',
      contract: escrow,
    },
    {
      name: 'PaymentDeferred',
      args: { to: agent, amount: '100' },
      at: start + 200,
      tx: 'award',
      contract: escrow,
    },
    created(base.bounties[1]),
  ];
  const apply = () => {
    const snapshot = agentState();
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
      eligibility(agentPolicy(), apply(), quest, creator, now).ok,
      false,
    );
  const withdrawal = {
    name: 'Withdrawn',
    args: { account: agent, amount: '100' },
    at: start + 500,
    tx: 'withdraw',
    contract: escrow,
  };
  logs.push(withdrawal);
  for (const quest of ['Q4', 'Q5']) {
    const result = eligibility(agentPolicy(), apply(), quest, creator, now);
    assert.equal(result.code, 'VERIFIED');
    assert.equal(result.agentAssistedEvidence[0].paymentTx, 'withdraw');
    assert.equal(result.agentAssistedEvidence[0].paidAt, start + 500);
  }
  withdrawal.at = base.bounties[1].createdAt;
  assert.equal(
    eligibility(agentPolicy(), apply(), 'Q5', creator, now).ok,
    false,
  );
  withdrawal.at = agentPolicy().endAt;
  assert.equal(
    eligibility(agentPolicy(), apply(), 'Q4', creator, now).ok,
    false,
  );
});
test('external hunters retain Q9 on team standard starters and Q10 with a later different non-team creator', () => {
  const snapshot = state();
  snapshot.bounties = [bounty(1, start, agent, hunter, 'standard')];
  snapshot.history.hunters[hunter] = true;
  assert.equal(
    eligibility(agentPolicy(), snapshot, 'Q9', hunter, now).code,
    'VERIFIED',
  );
  delete snapshot.history.hunters[hunter];
  snapshot.bounties[0].evidence.kind = 'workOrder';
  snapshot.bounties.push(
    bounty(2, start + 3 * DAY + 201, otherCreator, hunter),
  );
  assert.equal(
    eligibility(agentPolicy(), snapshot, 'Q10', hunter, now).code,
    'VERIFIED',
  );
  snapshot.bounties[1].creator = otherTeam;
  assert.equal(
    eligibility(agentPolicy(), snapshot, 'Q10', hunter, now).ok,
    false,
  );
  snapshot.bounties[1].creator = otherCreator;
  snapshot.history.hunters[hunter] = true;
  assert.equal(
    eligibility(agentPolicy(), snapshot, 'Q10', hunter, now).code,
    'PRE_CAMPAIGN_ACTIVITY',
  );
});
test('allowlist normalization, subset and uniqueness validation preserve disabled policy compatibility', (testContext) => {
  const input = configInput();
  delete input.verdiktaAgentWallets;
  const original = validateConfig(input, 'x'.repeat(32));
  const empty = validateConfig(
    { ...input, verdiktaAgentWallets: [] },
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
    { ...input, verdiktaAgentWallets: [getAddress(agent)] },
    'x'.repeat(32),
  );
  assert.deepEqual(enabled.verdiktaAgentWallets, [agent]);
  assert.notEqual(enabled.policyHash, original.policyHash);
  for (const allowlist of [
    [hunter],
    [agent, getAddress(agent)],
    'invalid',
    ['invalid-address'],
  ])
    assert.throws(() =>
      validateConfig(
        { ...input, verdiktaAgentWallets: allowlist },
        'x'.repeat(32),
      ),
    );
  const store = setup(testContext);
  const directory = path.join(path.dirname(store.file), 'agent-policy');
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
test('inspection preserves agent-assisted payment evidence, ordinary claims and Q9 reward candidates', (testContext) => {
  const store = setup(testContext);
  store.transact((snapshot) => {
    Object.assign(snapshot, agentState());
    snapshot.eligibilityPolicy = agentPolicy();
  });
  for (const quest of ['Q4', 'Q5', 'Q6', 'Q15'])
    assert.equal(
      verify(
        agentPolicy(),
        store,
        body(quest, creator, 'creator-user', quest),
        now,
      ).code,
      'VERIFIED',
    );
  store.transact((snapshot) => {
    // Later ledger changes must not erase the successful agent receipts in claims.
    snapshot.bounties = [
      bounty(3, start, agent, hunter, 'standard'),
      bounty(4, start, otherCreator, hunter),
    ];
    snapshot.history.hunters[hunter] = true;
  });
  assert.equal(
    verify(
      agentPolicy(),
      store,
      body('Q9', hunter, 'returning-hunter', 'q9'),
      now,
    ).code,
    'VERIFIED',
  );
  assert.equal(
    verify(
      agentPolicy(),
      store,
      body('Q4', otherCreator, 'organic-creator', 'organic-q4'),
      now,
    ).code,
    'VERIFIED',
  );
  assert.equal(CASH_QUESTS.includes('Q9'), false);
  const exported = inspect(store.file);
  assert.deepEqual(exported.verdiktaAgentWallets, [agent]);
  assert.equal(exported.verifiedAgentAssistedCreatorClaims.length, 4);
  const assisted = exported.verifiedAgentAssistedCreatorClaims.find(
    (claim) => claim.quest === 'Q6',
  );
  assert.deepEqual(
    assisted.evidence,
    agentState().bounties.map((record) => record.key),
  );
  assert.equal(assisted.agentAssistedEvidence.length, 2);
  assert.equal(assisted.agentAssistedEvidence[0].hunter, agent);
  assert.equal(assisted.agentAssistedEvidence[0].paymentTx, 'paid-1');
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
    ).agentAssistedEvidence.length,
    2,
  );
});
