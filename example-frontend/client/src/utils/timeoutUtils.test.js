import { Interface, makeError } from 'ethers';
import { CONTRACT_ABI } from './contractUtils';
import {
  driveRound,
  sendStep,
  stepGasLimit,
  revertName,
  isUserRejection,
  parseRoundInfo,
  PHASE,
  MAX_READ_FAILURES,
} from './timeoutUtils';

const iface = new Interface(CONTRACT_ABI);
const AGG_ID = '0x' + '0'.repeat(63) + '7'; // aggId = bytes32(roundId)
const REQUESTER = '0x742F15ebE4fCcC794a39dbBc00e3C5700A7BEB8D';
const TREASURY = '0x2222222222222222222222222222222222222222';
const TX_HASH = '0x' + 'ab'.repeat(32);
const FEE = 100000000000000n; // 0.0001 ETH per arbiter
const REFUND = 1080000000000000n;
const T0 = 1_800_000_000; // request time (s)
const B0 = 1000; // request block
const GAS = { drawJury: 2_345_517n, closeCommits: 60_000n, promote: 739_501n, settle: 247_422n };

/* ---------- a fake v2 aggregator and chain ---------- */

// The error ethers 6 raises when a dry run or an estimate reverts with a custom error.
const revertError = (name) =>
  makeError('execution reverted (unknown custom error)', 'CALL_EXCEPTION', {
    action: 'estimateGas',
    data: iface.getError(name).selector,
    reason: null,
    transaction: {},
    invocation: null,
    revert: null,
  });

// The error ethers 6 raises when the user refuses a transaction in the wallet.
const rejectedError = () =>
  makeError('user rejected action', 'ACTION_REJECTED', {
    action: 'sendTransaction',
    reason: 'rejected',
    info: { error: { code: 4001, message: 'MetaMask Tx Signature: User denied transaction signature.' } },
  });

const eventLog = (name, values) => {
  const { topics, data } = iface.encodeEventLog(name, values);
  return { topics, data };
};

/**
 * A round on a chain with a 2 s block time. Time only moves when the driver sleeps.
 * `arbiters` decides how the jury behaves: commits per 10 s up to `commits`, and a
 * result `revealAfter` seconds after promotion (null: never).
 */
function makeChain({
  withBeacons = false,
  beaconDelay = 20,
  commits = 6,
  commitEvery = 10,
  revealAfter = 20,
  K = 6,
  M = 5,
  startPhase = PHASE.DRAW,
  startTime = 0,
  wallet = 'approve',
} = {}) {
  const c = {
    t: startTime, // ms since the request was mined
    phase: startPhase,
    requestBlock: B0,
    requestTime: T0,
    closeBlock: 0,
    deadline: 0,
    windowEnd: 0,
    commits: 0,
    drawnAt: null,
    promotedAt: null,
    beaconReadyAt: null,
    withBeacons,
    wallet, // 'approve' | 'reject' | (fn, c) => Error to throw on send, or undefined to approve
    sent: [], // { fn, overrides } of every transaction the wallet sent
    refundEvents: [],
    readsFail: 0,
  };
  const ts = () => T0 + Math.floor(c.t / 1000);
  const num = () => B0 + Math.floor(c.t / 2000);
  const mPlus = M + Math.ceil((K - M) / 2);

  const draw = () => {
    c.phase = PHASE.COMMIT;
    c.drawnAt = ts();
    c.windowEnd = ts() + 155;
    c.deadline = ts() + 300;
  };

  // the arbiters, between blocks
  c.tick = () => {
    if (c.phase === PHASE.COMMIT && c.drawnAt !== null) {
      c.commits = Math.min(commits, Math.floor((ts() - c.drawnAt) / commitEvery));
      if (c.commits >= mPlus) {
        c.phase = PHASE.CLOSING;
        c.closeBlock = num();
      }
    }
    if (c.phase === PHASE.REVEAL && revealAfter !== null && ts() - c.promotedAt >= revealAfter) {
      c.phase = PHASE.FINAL;
    }
  };

  c.head = async () => ({ number: num(), timestamp: ts() });
  c.sleep = jest.fn(async (ms) => {
    c.t += ms;
    c.tick();
  });
  c.now = () => c.t;

  // The contract's rules, as the dry run sees them.
  const check = {
    drawJury: () => {
      if (c.phase !== PHASE.DRAW && c.phase !== PHASE.BEACONS) throw revertError('WrongPhase');
      if (ts() > c.requestTime + 86400) throw revertError('DrawExpired');
      if (c.phase === PHASE.DRAW && num() < c.requestBlock + 2) throw revertError('TooEarly');
      if (c.phase === PHASE.BEACONS && ts() < c.beaconReadyAt) throw revertError('TooEarly');
    },
    closeCommits: () => {
      if (c.phase !== PHASE.COMMIT || ts() <= c.windowEnd || c.commits < M || ts() > c.deadline) {
        throw revertError('WrongPhase');
      }
    },
    promote: () => {
      if (c.phase !== PHASE.CLOSING || ts() > c.deadline) throw revertError('WrongPhase');
      if (num() < c.closeBlock + 2) throw revertError('TooEarly');
    },
    settle: () => {
      if (c.phase < PHASE.COMMIT || c.phase >= PHASE.SETTLED) throw revertError('WrongPhase');
      if (ts() <= c.deadline) throw revertError('NotDue');
    },
  };

  // What a mined call does, and the logs it emits.
  const apply = {
    drawJury: (from) => {
      if (c.phase === PHASE.DRAW && c.withBeacons) {
        c.phase = PHASE.BEACONS;
        c.beaconReadyAt = ts() + beaconDelay;
        return [eventLog('BeaconStageStarted', [AGG_ID, 4])];
      }
      const anchor = c.phase === PHASE.BEACONS ? c.beaconReadyAt : c.requestTime;
      const reward = ts() <= anchor + 30 ? 2n * FEE : 0n;
      draw();
      return [eventLog('JuryDrawn', [AGG_ID, from, reward])];
    },
    closeCommits: () => {
      c.phase = PHASE.CLOSING;
      c.closeBlock = num();
      c.deadline = Math.max(c.deadline, ts() + 30);
      return [eventLog('CommitWindowClosed', [AGG_ID, num()])];
    },
    promote: () => {
      c.phase = PHASE.REVEAL;
      c.promotedAt = ts();
      c.deadline = Math.max(c.deadline, ts() + 120);
      return [eventLog('CommitPhaseComplete', [AGG_ID, M])];
    },
    settle: () => {
      const toTreasury = c.phase === PHASE.CLOSING || (c.phase === PHASE.COMMIT && c.commits >= M);
      c.phase = PHASE.FAILED;
      return [
        eventLog('RequesterRefunded', [AGG_ID, toTreasury ? TREASURY : REQUESTER, REFUND]),
        eventLog('EvaluationFailed', [AGG_ID, 5]),
        eventLog('RoundSettled', [AGG_ID, true]),
      ];
    },
  };

  const read = {
    interface: iface,
    getRoundInfo: jest.fn(async () => {
      if (c.readsFail > 0) {
        c.readsFail -= 1;
        throw new Error('network error');
      }
      return [
        c.phase, c.requestBlock, '0x' + '00'.repeat(32), c.closeBlock, 3000000000000000n, 0n, 0n, 0n,
        c.deadline, c.windowEnd, c.commits, c.requestTime,
      ];
    }),
    M: async () => BigInt(M),
    filters: { RequesterRefunded: (id) => ({ id }) },
    queryFilter: jest.fn(async () => c.refundEvents),
  };
  const write = { interface: iface };
  for (const fn of Object.keys(check)) {
    // provider-bound: reads and dry runs only
    read[fn] = jest.fn(async () => {
      throw makeError('contract runner does not support sending transactions', 'UNSUPPORTED_OPERATION', {
        operation: 'sendTransaction',
      });
    });
    read[fn].estimateGas = jest.fn(async (id, overrides) => {
      expect(id).toBe(AGG_ID);
      expect(overrides).toEqual({ from: REQUESTER });
      check[fn]();
      return GAS[fn];
    });
    // the user's wallet
    write[fn] = jest.fn(async (id, overrides) => {
      if (c.wallet === 'reject') throw rejectedError();
      if (typeof c.wallet === 'function') {
        const error = c.wallet(fn, c);
        if (error) throw error;
      }
      c.sent.push({ fn, overrides, at: c.t });
      return {
        hash: TX_HASH,
        wait: async () => {
          let logs;
          try {
            check[fn](); // mined: the same rules apply, a reverting call fails
            logs = apply[fn](REQUESTER);
          } catch (error) {
            return { status: 0, hash: TX_HASH, logs: [] };
          }
          return { status: 1, hash: TX_HASH, logs };
        },
      };
    });
  }
  c.read = read;
  c.write = write;
  c.getWriteContract = jest.fn(async () => write);
  return c;
}

function drive(c, extra = {}) {
  const onRound = jest.fn();
  const onStep = jest.fn();
  const setTransactionStatus = jest.fn();
  const promise = driveRound({
    readContract: c.read,
    getWriteContract: c.getWriteContract,
    aggId: AGG_ID,
    account: REQUESTER,
    withBeacons: c.withBeacons,
    getHead: c.head,
    checkForResult: async () => c.phase === PHASE.FINAL || c.phase === PHASE.SETTLED,
    onRound,
    onStep,
    setTransactionStatus,
    now: c.now,
    sleep: c.sleep,
    ...extra,
  });
  return { promise, onRound, onStep, setTransactionStatus };
}

const sentFns = (c) => c.sent.map((s) => s.fn);

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

/* ---------- driving a round ---------- */

describe('driving a round with the user wallet', () => {
  test('draws at B+2, promotes at C+2, and returns the result', async () => {
    const c = makeChain();
    const { promise, onStep, onRound } = drive(c);
    const result = await promise;

    expect(result.status).toBe('fulfilled');
    expect(sentFns(c)).toEqual(['drawJury', 'promote']);

    // drawJury not before block B+2 (4 s at 2 s blocks), and well within the 30 s priority
    const draw = c.sent[0];
    expect(B0 + Math.floor(draw.at / 2000)).toBeGreaterThanOrEqual(B0 + 2);
    expect(draw.at).toBeLessThan(30_000);
    // the reward the draw earned is reported
    expect(onStep).toHaveBeenCalledWith({ step: 'draw', txHash: TX_HASH, rewardWei: 2n * FEE });
    expect(onStep).toHaveBeenCalledWith({ step: 'promote', txHash: TX_HASH, rewardWei: null });

    // every phase was shown on the way
    const phases = onRound.mock.calls.map(([round]) => round.phase);
    expect(phases).toEqual(expect.arrayContaining([PHASE.DRAW, PHASE.COMMIT, PHASE.CLOSING, PHASE.REVEAL, PHASE.FINAL]));
  });

  test('each call is dry-run from the user address and sent with the estimate plus half', async () => {
    const c = makeChain();
    await drive(c).promise;

    expect(c.read.drawJury.estimateGas).toHaveBeenCalled();
    expect(c.sent[0].overrides).toEqual({ gasLimit: (GAS.drawJury * 3n) / 2n });
    expect(c.sent[1].overrides).toEqual({ gasLimit: (GAS.promote * 3n) / 2n });
    // the provider-bound contract is never asked to send
    expect(c.read.drawJury).not.toHaveBeenCalled();
    expect(c.read.promote).not.toHaveBeenCalled();
  });

  test('promote waits for block C+2 after the commit window closed', async () => {
    const c = makeChain();
    await drive(c).promise;
    const promoteAt = c.sent[1].at;
    expect(B0 + Math.floor(promoteAt / 2000)).toBeGreaterThanOrEqual(c.closeBlock + 2);
  });

  test('with beacons: one drawJury starts the stage, a second draws once the beacons are in', async () => {
    const c = makeChain({ withBeacons: true, beaconDelay: 20 });
    const { promise, setTransactionStatus } = drive(c);
    const result = await promise;

    expect(result.status).toBe('fulfilled');
    expect(sentFns(c)).toEqual(['drawJury', 'drawJury', 'promote']);
    // the second draw is sent only once the dry run passes (the beacon values are in)
    expect(T0 + Math.floor(c.sent[1].at / 1000)).toBeGreaterThanOrEqual(c.beaconReadyAt);
    expect(setTransactionStatus).toHaveBeenCalledWith(expect.stringMatching(/beacon stage/));
    expect(setTransactionStatus).toHaveBeenCalledWith(expect.stringMatching(/Waiting for the beacon values/));
  });

  test('closes the commit window after T+ when M but not M+ arbiters committed', async () => {
    const c = makeChain({ commits: 5 }); // M = 5, M+ = 6
    const result = await drive(c).promise;

    expect(result.status).toBe('fulfilled');
    expect(sentFns(c)).toEqual(['drawJury', 'closeCommits', 'promote']);
    // not before the window's end
    expect(T0 + Math.floor(c.sent[1].at / 1000)).toBeGreaterThan(c.windowEnd);
  });

  test('too few commits: no closeCommits, then settle after the deadline refunds the user', async () => {
    const c = makeChain({ commits: 3 });
    const { promise, onStep } = drive(c);
    const result = await promise;

    expect(sentFns(c)).toEqual(['drawJury', 'settle']);
    expect(T0 + Math.floor(c.sent[1].at / 1000)).toBeGreaterThan(c.deadline);
    expect(result).toMatchObject({
      status: 'failed',
      failedPhase: PHASE.COMMIT,
      settledBy: 'user',
      txHash: TX_HASH,
      refund: { amount: REFUND, toRequester: true },
    });
    expect(onStep).toHaveBeenCalledWith({ step: 'settle', txHash: TX_HASH, rewardWei: null });
  });

  test('no reveals by the deadline: settle after it, refund to the user', async () => {
    const c = makeChain({ revealAfter: null });
    const result = await drive(c).promise;
    expect(sentFns(c)).toEqual(['drawJury', 'promote', 'settle']);
    expect(result).toMatchObject({ status: 'failed', failedPhase: PHASE.REVEAL, refund: { toRequester: true } });
  });

  test('a dry run that says TooEarly (node a block behind) is retried, and nothing reverting is sent', async () => {
    const c = makeChain();
    let lag = 2;
    const realEstimate = c.read.drawJury.estimateGas.getMockImplementation();
    c.read.drawJury.estimateGas.mockImplementation(async (...args) => {
      if (lag-- > 0) throw revertError('TooEarly');
      return realEstimate(...args);
    });
    const result = await drive(c).promise;
    expect(result.status).toBe('fulfilled');
    expect(sentFns(c)).toEqual(['drawJury', 'promote']);
  });
});

/* ---------- when the user does not send, or someone else does ---------- */

describe('stalls and other accounts', () => {
  test('declined draw: the round is reported waiting for the draw, and a second call picks it up', async () => {
    const c = makeChain({ wallet: 'reject' });
    const first = await drive(c).promise;
    expect(first).toMatchObject({ status: 'stalled', step: 'draw', reason: 'declined' });
    expect(first.round.phase).toBe(PHASE.DRAW);
    expect(c.sent).toHaveLength(0);

    c.wallet = 'approve';
    const second = await drive(c).promise;
    expect(second.status).toBe('fulfilled');
    expect(sentFns(c)).toEqual(['drawJury', 'promote']);
  });

  test('declined promote: waiting for the promotion', async () => {
    const c = makeChain({ wallet: (fn) => (fn === 'promote' ? rejectedError() : undefined) });
    const result = await drive(c).promise;
    expect(result).toMatchObject({ status: 'stalled', step: 'promote', reason: 'declined' });
    expect(sentFns(c)).toEqual(['drawJury']);
  });

  test('no wallet: nothing sent, the step is reported', async () => {
    const c = makeChain();
    c.getWriteContract.mockRejectedValue(new Error('No Ethereum wallet detected.'));
    const result = await drive(c).promise;
    expect(result).toMatchObject({ status: 'stalled', step: 'draw', reason: 'no-wallet' });
    expect(result.errorMessage).toMatch(/No Ethereum wallet/);
  });

  test('another account drew first: the user call fails, the page carries on', async () => {
    const c = makeChain({
      wallet: (fn, chain) => {
        if (fn === 'drawJury' && chain.phase === PHASE.DRAW) {
          // a third party's draw lands while the wallet prompt is open
          chain.phase = PHASE.COMMIT;
          chain.drawnAt = T0 + Math.floor(chain.t / 1000);
          chain.windowEnd = chain.drawnAt + 155;
          chain.deadline = chain.drawnAt + 300;
          return makeError('execution reverted', 'CALL_EXCEPTION', { data: iface.getError('WrongPhase').selector });
        }
        return undefined;
      },
    });
    const result = await drive(c).promise;
    expect(result.status).toBe('fulfilled');
    expect(sentFns(c)).toEqual(['promote']);
  });

  test('the page is told when reads keep failing', async () => {
    const c = makeChain();
    c.readsFail = MAX_READ_FAILURES;
    const result = await drive(c).promise;
    expect(result).toMatchObject({ status: 'stalled', step: null, reason: 'check-failed' });
  });
});

/* ---------- rounds that cannot give the user anything back ---------- */

describe('rounds that end without a refund to the user', () => {
  test('promote missed (deadline passed in the closing phase): no settle is sent', async () => {
    const c = makeChain({ startPhase: PHASE.CLOSING, startTime: 400_000 });
    c.closeBlock = B0 + 10;
    c.deadline = T0 + 330;
    const result = await drive(c).promise;
    expect(result).toMatchObject({ status: 'expired', reason: 'promote-missed' });
    expect(c.sent).toHaveLength(0);
  });

  test('M commits but the window never closed by the deadline: no settle is sent', async () => {
    const c = makeChain({ startPhase: PHASE.COMMIT, startTime: 400_000 });
    c.drawnAt = T0 + 10;
    c.commits = 5;
    c.windowEnd = T0 + 165;
    c.deadline = T0 + 310;
    c.tick = () => {};
    const result = await drive(c).promise;
    expect(result).toMatchObject({ status: 'expired', reason: 'close-missed' });
    expect(c.sent).toHaveLength(0);
  });

  test('a round never drawn for a day cannot be drawn', async () => {
    const c = makeChain({ startTime: (86400 + 60) * 1000 });
    const result = await drive(c).promise;
    expect(result).toMatchObject({ status: 'expired', reason: 'draw-expired' });
    expect(c.sent).toHaveLength(0);
  });

  test('a round another account settled: failed, refund read from the logs', async () => {
    const c = makeChain({ startPhase: PHASE.FAILED });
    c.refundEvents = [{ args: { aggRequestId: AGG_ID, requester: TREASURY, amount: REFUND } }];
    const result = await drive(c).promise;
    expect(result).toMatchObject({ status: 'failed', settledBy: 'other', refund: { amount: REFUND, toRequester: false } });
    expect(c.read.queryFilter).toHaveBeenCalledWith({ id: AGG_ID }, B0);
  });

  test('a cancelled round is reported as such', async () => {
    const c = makeChain({ startPhase: PHASE.CANCELLED });
    const result = await drive(c).promise;
    expect(result.status).toBe('cancelled');
  });
});

/* ---------- helpers ---------- */

describe('helpers', () => {
  test('stepGasLimit pads the estimate by half, with no fixed floor', () => {
    expect(stepGasLimit(2_000_000n)).toBe(3_000_000n);
    expect(stepGasLimit(247_422)).toBe(371_133n);
  });

  test('revertName finds v2 errors by selector, by name, or from ethers', () => {
    expect(revertName(revertError('TooEarly'))).toBe('TooEarly');
    expect(revertName({ revert: { name: 'DrawExpired' } })).toBe('DrawExpired');
    expect(revertName({ message: 'execution reverted: NotDue()' })).toBe('NotDue');
    expect(revertName({ info: { error: { data: iface.getError('SeedExpired').selector } } })).toBe('SeedExpired');
    expect(revertName({ message: 'execution reverted' })).toBeNull();
    // v1 names are gone
    expect(revertName({ message: 'NotTimedOut()' })).toBeNull();
  });

  test('isUserRejection', () => {
    expect(isUserRejection(rejectedError())).toBe(true);
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error('nonce too low'))).toBe(false);
  });

  test('parseRoundInfo turns getRoundInfo into numbers and bigints', () => {
    const r = parseRoundInfo([3n, 100n, '0x00', 0n, 5n, 1n, 2n, 3n, 1300n, 1155n, 4n, 1000n]);
    expect(r).toMatchObject({
      phase: 3, requestBlock: 100, closeBlock: 0, received: 5n, rewards: 3n,
      deadline: 1300, windowEnd: 1155, commits: 4, requestTime: 1000,
    });
  });

  test('sendStep: a reverting dry run sends nothing', async () => {
    const c = makeChain(); // block B: drawJury is TooEarly
    const out = await sendStep({ step: 'draw', readContract: c.read, getWriteContract: c.getWriteContract, aggId: AGG_ID, account: REQUESTER });
    expect(out).toMatchObject({ ok: false, reason: 'revert', revert: 'TooEarly' });
    expect(c.getWriteContract).not.toHaveBeenCalled();
    expect(c.sent).toHaveLength(0);
  });

  test('sendStep: a sped-up transaction counts as mined', async () => {
    const c = makeChain();
    c.t = 4000;
    c.write.drawJury.mockResolvedValue({
      hash: TX_HASH,
      wait: async () => {
        throw Object.assign(new Error('replaced'), {
          code: 'TRANSACTION_REPLACED',
          reason: 'repriced',
          receipt: { status: 1, hash: '0x' + 'cd'.repeat(32), logs: [] },
        });
      },
    });
    const out = await sendStep({ step: 'draw', readContract: c.read, getWriteContract: c.getWriteContract, aggId: AGG_ID, account: REQUESTER });
    expect(out).toMatchObject({ ok: true, txHash: '0x' + 'cd'.repeat(32) });
  });
});
