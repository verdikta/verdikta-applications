'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../store');
const { key } = require('../ledger');
const { QUESTS, DAY } = require('../config');
const { emptyExceptions } = require('../exceptions');
const address = (number) => `0x${String(number).padStart(40, '0')}`;
const creator = address(1);
const hunter = address(2);
const hunterTwo = address(3);
const otherCreator = address(4);
const escrow = address(9);
const start = 1800000000;
const now = start + 10 * DAY;
function config() {
  return {
    id: 'pilot',
    snapshotSetHash: 'snapshots',
    communityId: 'community',
    subdomain: 'verdikta',
    startAt: start,
    endAt: start + 21 * DAY,
    claimEndAt: start + 24 * DAY,
    maxAgeSeconds: 3600,
    minimumWei: '100',
    minimumWindowHours: 4,
    maximumWindowHours: 336,
    teamWallets: [],
    priorWallets: { creators: [], hunters: [] },
    deployment: { chainId: 8453, address: escrow },
    quests: Object.fromEntries(QUESTS.map((quest) => [quest, quest])),
  };
}
function bounty(
  id,
  createdAt = start,
  owner = creator,
  winner = hunter,
  kind = 'workOrder',
) {
  return {
    key: key(escrow, id),
    chainId: 8453,
    contract: escrow,
    id: String(id),
    creator: owner,
    createdAt,
    originalWei: '100',
    deadline: createdAt + DAY,
    open: true,
    refunded: false,
    evidence: {
      ok: true,
      kind,
      scopeDigest: `scope-${id}`,
      templateId: id === 1 ? 'source-check-v1' : 'review-v1',
    },
    submissions: [
      {
        hunter: winner,
        id: '0',
        started: true,
        passed: true,
        packageValid: true,
        submittedAt: createdAt + 100,
        finalizedAt: createdAt + 200,
      },
    ],
    payment: { winner, amount: '100', at: createdAt + 200, tx: `paid-${id}` },
  };
}
function state() {
  return {
    chain: { error: null, checkedAt: now, historyComplete: true, logs: [] },
    wallets: {},
    exceptions: emptyExceptions(),
    history: { creators: {}, hunters: {} },
    bounties: [bounty(1), bounty(2, start + 3 * DAY + 201, creator, hunterTwo)],
  };
}
function setup(testContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-test-'));
  const store = new Store(directory, 'policy');
  store.transact((snapshot) => Object.assign(snapshot, state()));
  testContext.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
function body(
  quest = 'Q3',
  wallet = creator,
  userId = 'user',
  requestId = 'request',
) {
  return {
    userId,
    communityId: 'community',
    subdomain: 'verdikta',
    questId: quest,
    requestId,
    accounts: { wallet },
  };
}
const review = () => ({
  reviewer: 'operator',
  reviewedAt: '2026-10-08T00:00:00Z',
  reason: 'Reviewed fixture exception',
});
module.exports = {
  address,
  creator,
  hunter,
  hunterTwo,
  otherCreator,
  escrow,
  start,
  now,
  config,
  bounty,
  state,
  setup,
  body,
  review,
};
