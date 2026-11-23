import { ethers, Interface, makeError } from 'ethers';
import { CONTRACT_ABI } from './contractUtils';
import {
  waitForFulfilOrTimeout,
  closeTimedOutRound,
  finalizeGasLimit,
  revertName,
  isUserRejection,
  FINALIZE_GAS_FLOOR,
  SAFETY_MARGIN_MS,
} from './timeoutUtils';

const iface = new Interface(CONTRACT_ABI);
const REQUEST_ID = '0x550c3efce479f5d364a86733cd47890d426214c55058f006cec0b26677c73608';
const REQUESTER = '0x742F15ebE4fCcC794a39dbBc00e3C5700A7BEB8D';
const TX_HASH = '0x' + 'ab'.repeat(32);
const REFUND = 1080000000000000n; // 0.00108 ETH, as measured on a fork of Base mainnet
const ESTIMATE = 1888985n;        // the node's gas estimate measured on the same fork

/* ---------- helpers ---------- */

// A clock the tests control: sleeping advances it, nothing really waits.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: jest.fn(async (ms) => { t += ms; }),
  };
}

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

const finalizedReceipt = (refund = REFUND) => ({
  status: 1,
  hash: TX_HASH,
  logs: [
    ...(refund > 0n ? [eventLog('RequesterRefunded', [REQUEST_ID, REQUESTER, refund])] : []),
    eventLog('EvaluationTimedOut', [REQUEST_ID]),
    eventLog('EvaluationFailed', [REQUEST_ID, 'commit']),
  ],
});

/**
 * A stand-in for the page's two contracts. `read` is bound to a provider and can only
 * read and estimate; `write` is bound to the user's wallet.
 */
function makeContracts({
  estimateGas = jest.fn(async () => ESTIMATE),
  isFailed = jest.fn(async () => false),
  send = jest.fn(async () => ({ hash: TX_HASH, wait: jest.fn(async () => finalizedReceipt()) })),
} = {}) {
  const readFinalize = jest.fn(async () => {
    // What ethers 6 does when a provider-bound contract is asked to send.
    throw makeError('contract runner does not support sending transactions', 'UNSUPPORTED_OPERATION', {
      operation: 'sendTransaction',
    });
  });
  readFinalize.estimateGas = estimateGas;
  const read = { interface: iface, finalizeEvaluationTimeout: readFinalize, isFailed };
  const write = { interface: iface, finalizeEvaluationTimeout: send };
  const getWriteContract = jest.fn(async () => write);
  return { read, write, getWriteContract, estimateGas, isFailed, send, readFinalize };
}

function run({ contracts, clock = fakeClock(), checkForResult = jest.fn(async () => false), seconds = 300, ...rest }) {
  const setTransactionStatus = jest.fn();
  const promise = waitForFulfilOrTimeout({
    readContract: contracts.read,
    getWriteContract: contracts.getWriteContract,
    requestId: REQUEST_ID,
    checkForResult,
    responseTimeoutSeconds: seconds,
    setTransactionStatus,
    now: clock.now,
    sleep: clock.sleep,
    ...rest,
  });
  return { promise, clock, checkForResult, setTransactionStatus };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

/* ---------- timing ---------- */

describe('how long the page waits', () => {
  test.each([
    ['Base mainnet', 300],
    ['Base Sepolia', 900],
  ])('%s: polls every 5 s for the whole %i s timeout before asking the wallet', async (_name, seconds) => {
    const contracts = makeContracts();
    const clock = fakeClock();
    const askedAt = [];
    contracts.getWriteContract.mockImplementation(async () => {
      askedAt.push(clock.now());
      return contracts.write;
    });
    const checkedAt = [];
    const checkForResult = jest.fn(async () => {
      checkedAt.push(clock.now());
      return false;
    });

    const { promise } = run({ contracts, clock, checkForResult, seconds });
    const result = await promise;

    const timeoutMs = seconds * 1000;
    // One check every 5 s from 0 to the timeout, both ends included.
    const duringWait = checkedAt.filter((t) => t <= timeoutMs);
    expect(duringWait).toHaveLength(seconds / 5 + 1);
    expect(duringWait[1] - duringWait[0]).toBe(5000);
    // The wallet is asked once, and only after the timeout plus the safety margin.
    expect(askedAt).toEqual([timeoutMs + SAFETY_MARGIN_MS]);
    expect(contracts.send).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('timed-out');
  });

  test('a result at 600 s is still a result when the timeout is 900 s', async () => {
    const contracts = makeContracts();
    const clock = fakeClock();
    const checkForResult = jest.fn(async () => clock.now() >= 600_000);

    const { promise } = run({ contracts, clock, checkForResult, seconds: 900 });

    await expect(promise).resolves.toEqual({ status: 'fulfilled' });
    expect(clock.now()).toBe(600_000);
    expect(contracts.estimateGas).not.toHaveBeenCalled();
    expect(contracts.getWriteContract).not.toHaveBeenCalled();
  });

  test('a failed read does not end the wait', async () => {
    const contracts = makeContracts();
    let calls = 0;
    const checkForResult = jest.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('rpc hiccup');
      return calls === 4;
    });

    const { promise, clock } = run({ contracts, checkForResult });

    await expect(promise).resolves.toEqual({ status: 'fulfilled' });
    expect(clock.now()).toBe(15_000);
  });

  test('refuses a timeout it cannot use', async () => {
    const contracts = makeContracts();
    await expect(run({ contracts, seconds: NaN }).promise).rejects.toThrow('Invalid response timeout');
    await expect(run({ contracts, seconds: 0 }).promise).rejects.toThrow('Invalid response timeout');
  });
});

/* ---------- outcome 1: fulfilled ---------- */

describe('a round that completes', () => {
  test('while the page waits: shown as a result, nothing is sent', async () => {
    const contracts = makeContracts();
    let calls = 0;
    const checkForResult = jest.fn(async () => ++calls === 10);

    const { promise, clock } = run({ contracts, checkForResult });

    await expect(promise).resolves.toEqual({ status: 'fulfilled' });
    expect(clock.now()).toBe(45_000);
    expect(contracts.estimateGas).not.toHaveBeenCalled();
    expect(contracts.send).not.toHaveBeenCalled();
  });

  test('just as the timeout passes: the dry run reverts with AggregationComplete and the result is shown', async () => {
    let complete = false;
    const contracts = makeContracts({
      estimateGas: jest.fn(async () => {
        complete = true; // the last answer landed between the final poll and the dry run
        throw revertError('AggregationComplete');
      }),
    });
    const checkForResult = jest.fn(async () => complete);

    const { promise } = run({ contracts, checkForResult });

    await expect(promise).resolves.toEqual({ status: 'fulfilled' });
    expect(contracts.getWriteContract).not.toHaveBeenCalled();
    expect(contracts.send).not.toHaveBeenCalled();
  });

  test('while the closing transaction is in flight: the reverted transaction counts as success', async () => {
    let complete = false;
    const wait = jest.fn(async () => {
      complete = true;
      throw makeError('transaction execution reverted', 'CALL_EXCEPTION', {
        action: 'sendTransaction',
        data: null,
        reason: null,
        invocation: null,
        revert: null,
        transaction: {},
        receipt: { status: 0, hash: TX_HASH, logs: [] },
      });
    });
    const contracts = makeContracts({ send: jest.fn(async () => ({ hash: TX_HASH, wait })) });
    const checkForResult = jest.fn(async () => complete);

    const { promise } = run({ contracts, checkForResult });

    await expect(promise).resolves.toEqual({ status: 'fulfilled' });
    expect(contracts.send).toHaveBeenCalledTimes(1);
  });

  test('because the closing transaction itself found enough answers', async () => {
    let mined = false;
    const wait = jest.fn(async () => {
      mined = true;
      return { status: 1, hash: TX_HASH, logs: [] };
    });
    const contracts = makeContracts({ send: jest.fn(async () => ({ hash: TX_HASH, wait })) });
    const checkForResult = jest.fn(async () => mined);

    await expect(run({ contracts, checkForResult }).promise).resolves.toEqual({ status: 'fulfilled' });
  });
});

/* ---------- outcome 2: timed out and finalized ---------- */

describe('no result by the timeout, round closed', () => {
  test("the user's wallet sends finalizeEvaluationTimeout and the refund is reported", async () => {
    const contracts = makeContracts();

    const { promise, setTransactionStatus } = run({ contracts });
    const result = await promise;

    expect(result).toEqual({
      status: 'timed-out',
      round: 'closed',
      closedBy: 'user',
      txHash: TX_HASH,
      refundWei: REFUND,
    });
    // Sent with the wallet-bound contract, never with the read-only one.
    expect(contracts.send).toHaveBeenCalledWith(REQUEST_ID, { gasLimit: FINALIZE_GAS_FLOOR });
    expect(contracts.readFinalize).not.toHaveBeenCalled();
    const statuses = setTransactionStatus.mock.calls.map(([text]) => text);
    expect(statuses[0]).toBe('Waiting for evaluation results...');
    expect(statuses.some((text) => /Confirm the transaction in your wallet/.test(text))).toBe(true);
    expect(statuses[statuses.length - 1]).toBe('Closing the round on the blockchain...');
  });

  test('a round that had nothing left to return reports a refund of zero', async () => {
    const wait = jest.fn(async () => finalizedReceipt(0n));
    const contracts = makeContracts({ send: jest.fn(async () => ({ hash: TX_HASH, wait })) });

    const result = await run({ contracts }).promise;

    expect(result).toMatchObject({ round: 'closed', closedBy: 'user', refundWei: 0n });
  });

  test('a transaction the user sped up in the wallet still counts', async () => {
    const wait = jest.fn(async () => {
      throw makeError('transaction was replaced', 'TRANSACTION_REPLACED', {
        cancelled: false,
        reason: 'repriced',
        hash: TX_HASH,
        replacement: {},
        receipt: { ...finalizedReceipt(), hash: '0x' + 'cd'.repeat(32) },
      });
    });
    const contracts = makeContracts({ send: jest.fn(async () => ({ hash: TX_HASH, wait })) });

    const result = await run({ contracts }).promise;

    expect(result).toMatchObject({ round: 'closed', closedBy: 'user', refundWei: REFUND, txHash: '0x' + 'cd'.repeat(32) });
  });

  test('another account closed it first: reported as closed, nothing is sent', async () => {
    const contracts = makeContracts({
      estimateGas: jest.fn(async () => { throw revertError('AggregationComplete'); }),
      isFailed: jest.fn(async () => true),
    });

    const result = await run({ contracts }).promise;

    expect(result).toEqual({ status: 'timed-out', round: 'closed', closedBy: 'other' });
    expect(contracts.send).not.toHaveBeenCalled();
  });

  test('the gas limit is the estimate plus 50%, and never below the floor', () => {
    expect(finalizeGasLimit(ESTIMATE)).toBe(3_000_000n);
    expect(finalizeGasLimit(2_400_000n)).toBe(3_600_000n);
    expect(finalizeGasLimit(100n)).toBe(FINALIZE_GAS_FLOOR);
  });
});

/* ---------- outcome 3: user declined ---------- */

describe('no result by the timeout, round still open', () => {
  test('the user declines the transaction', async () => {
    const send = jest.fn(async () => { throw rejectedError(); });
    const contracts = makeContracts({ send });

    const result = await run({ contracts }).promise;

    expect(result).toEqual({ status: 'timed-out', round: 'open', reason: 'declined' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('closeTimedOutRound() gives the user a second chance later', async () => {
    const contracts = makeContracts();
    const clock = fakeClock();

    const result = await closeTimedOutRound({
      readContract: contracts.read,
      getWriteContract: contracts.getWriteContract,
      requestId: REQUEST_ID,
      checkForResult: jest.fn(async () => false),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ round: 'closed', closedBy: 'user', refundWei: REFUND });
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  test('the old fault: a contract without a signer cannot send, and that is not a result', async () => {
    // RunQuery used to pass its read-only contract here. ethers 6 then throws
    // UNSUPPORTED_OPERATION, which the old code reported as "fulfilled".
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:1', 8453, { staticNetwork: true });
    const readOnly = new ethers.Contract(REQUESTER, CONTRACT_ABI, provider);
    const contracts = makeContracts();
    contracts.getWriteContract.mockResolvedValue(readOnly);

    const result = await run({ contracts }).promise;
    provider.destroy();

    expect(result.status).toBe('timed-out');
    expect(result).toMatchObject({ round: 'open', reason: 'send-failed' });
    expect(result.errorMessage).toMatch(/does not support sending transactions/);
  });

  test('no wallet can be reached', async () => {
    const contracts = makeContracts();
    contracts.getWriteContract.mockRejectedValue(new Error('No Ethereum wallet detected. Please install MetaMask.'));

    const result = await run({ contracts }).promise;

    expect(result).toMatchObject({ status: 'timed-out', round: 'open', reason: 'no-wallet' });
    expect(result.errorMessage).toMatch(/No Ethereum wallet/);
  });

  test('the wallet cannot pay for gas', async () => {
    const send = jest.fn(async () => {
      throw makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS', { transaction: {} });
    });
    const contracts = makeContracts({ send });

    const result = await run({ contracts }).promise;

    expect(result).toMatchObject({ status: 'timed-out', round: 'open', reason: 'send-failed' });
    expect(result.errorMessage).toMatch(/insufficient funds/);
  });

  test('the transaction is mined but fails, and the round is still open', async () => {
    const wait = jest.fn(async () => {
      throw makeError('transaction execution reverted', 'CALL_EXCEPTION', {
        action: 'sendTransaction', data: null, reason: null, invocation: null, revert: null,
        transaction: {}, receipt: { status: 0, hash: TX_HASH, logs: [] },
      });
    });
    const contracts = makeContracts({ send: jest.fn(async () => ({ hash: TX_HASH, wait })) });

    const result = await run({ contracts }).promise;

    expect(result).toMatchObject({ status: 'timed-out', round: 'open', reason: 'tx-failed', txHash: TX_HASH });
  });

  test('the chain says "not timed out yet": the page waits, keeps polling, then sends', async () => {
    let estimates = 0;
    const estimateGas = jest.fn(async () => {
      estimates += 1;
      if (estimates <= 2) throw revertError('NotTimedOut');
      return ESTIMATE;
    });
    const contracts = makeContracts({ estimateGas });

    const { promise, clock } = run({ contracts });
    const result = await promise;

    expect(result).toMatchObject({ round: 'closed', closedBy: 'user' });
    expect(estimateGas).toHaveBeenCalledTimes(3);
    expect(clock.now()).toBe(300_000 + SAFETY_MARGIN_MS + 2 * 5_000);
  });

  test('the chain keeps saying "not timed out yet": nothing is sent and the round is reported open', async () => {
    const contracts = makeContracts({
      estimateGas: jest.fn(async () => { throw revertError('NotTimedOut'); }),
    });

    const { promise, clock } = run({ contracts });
    const result = await promise;

    expect(result).toEqual({ status: 'timed-out', round: 'open', reason: 'not-timed-out-yet' });
    expect(contracts.send).not.toHaveBeenCalled();
    expect(clock.now()).toBe(300_000 + SAFETY_MARGIN_MS + 60_000);
  });

  test('the dry run fails for an unknown reason: nothing is sent', async () => {
    const contracts = makeContracts({
      estimateGas: jest.fn(async () => { throw new Error('network down'); }),
    });

    const result = await run({ contracts }).promise;

    expect(result).toMatchObject({ status: 'timed-out', round: 'open', reason: 'check-failed', errorMessage: 'network down' });
    expect(contracts.send).not.toHaveBeenCalled();
  });
});

/* ---------- reading errors ---------- */

describe('revertName()', () => {
  const selector = (name) => iface.getError(name).selector;

  test('reads the error ethers decoded from the ABI', () => {
    expect(revertName({ code: 'CALL_EXCEPTION', revert: { name: 'NotTimedOut', args: [] } })).toBe('NotTimedOut');
  });

  test('reads the selector from an estimateGas error', () => {
    expect(revertName(revertError('AggregationComplete'))).toBe('AggregationComplete');
    expect(revertName(revertError('NotTimedOut'))).toBe('NotTimedOut');
    expect(revertName(revertError('UnknownRequest'))).toBe('UnknownRequest');
  });

  test('reads the selector from a raw node error (anvil, geth)', () => {
    const raw = { code: 3, message: 'execution reverted: custom error 0x828630fb', data: selector('NotTimedOut') };
    expect(selector('NotTimedOut')).toBe('0x828630fb');
    expect(revertName({ code: 'UNKNOWN_ERROR', message: 'could not coalesce error', info: { error: raw } })).toBe('NotTimedOut');
  });

  test('reads the selector from a wallet that nests the node error', () => {
    const nested = {
      code: -32603,
      message: 'Internal JSON-RPC error.',
      data: { code: 3, message: 'execution reverted', data: selector('AggregationComplete') },
    };
    expect(selector('AggregationComplete')).toBe('0x5a811b49');
    expect(revertName({ code: 'UNKNOWN_ERROR', message: 'could not coalesce error', info: { error: nested } })).toBe('AggregationComplete');
  });

  test('returns null for anything else', () => {
    expect(revertName(new Error('network down'))).toBeNull();
    expect(revertName(rejectedError())).toBeNull();
    expect(revertName(null)).toBeNull();
  });
});

describe('isUserRejection()', () => {
  test('recognises the shapes wallets use', () => {
    expect(isUserRejection(rejectedError())).toBe(true);
    expect(isUserRejection({ code: 4001, message: 'User rejected the request.' })).toBe(true);
    expect(isUserRejection(new Error('MetaMask Tx Signature: User denied transaction signature.'))).toBe(true);
  });

  test('does not mistake other failures for a refusal', () => {
    expect(isUserRejection(revertError('NotTimedOut'))).toBe(false);
    expect(isUserRejection(new Error('insufficient funds'))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});
