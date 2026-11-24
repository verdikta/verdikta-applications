/**
 * The Run Query page, from "Run Query" to the end of the round, against a fake v2
 * aggregator. These tests drive the real page and the real timeoutUtils; only ethers'
 * provider and contract classes, the wallet and the server calls are replaced.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import RunQuery, { PENDING_ROUND_KEY } from './RunQuery';
import { fetchWithRetry, tryParseJustification } from '../utils/fetchUtils';

const AGGREGATOR = '0x000000000000000000000000000000000000dEaD'; // placeholder: no v2 address yet
const MOCK_WALLET = '0x742F15ebE4fCcC794a39dbBc00e3C5700A7BEB8D';
const MOCK_AGG_ID = '0x' + '0'.repeat(63) + '7';
const MOCK_TX_HASH = '0x' + 'ab'.repeat(32);
const MOCK_MAX_FEE = 100000000000000n; // 0.0001 ETH
const MOCK_REFUND = 1080000000000000n; // 0.00108 ETH

// The fake chain. Names start with "mock" so the jest.mock factories below may use them.
const mockChain = {};
function resetChain() {
  Object.assign(mockChain, {
    chainId: 8453n,
    ethOwed: 0n,
    phase: 0, // no round until the request is mined
    minedAt: null, // Date.now() when the request was mined
    drawnAt: null,
    promotedAt: null,
    closeBlock: 0,
    deadline: 0,
    windowEnd: 0,
    commits: 0,
    maxCommits: 6, // M+ = 6 for K = 6, M = 5: the window closes by itself
    revealAfter: 20, // seconds from promotion to the result (null: never)
    evaluation: [[], '', false],
    wallet: () => undefined, // (fn) => an Error to throw instead of sending
    sent: [], // { fn, args, overrides, signer }
    maxTotalFeeArgs: null,
    jury: null, // the jury the request carried, returned by getJury
  });
}
const MOCK_B0 = 5000;
const MOCK_T0 = 1_800_000_000;

function mockElapsed() {
  return mockChain.minedAt === null ? 0 : Date.now() - mockChain.minedAt;
}
function mockHead() {
  const ms = mockElapsed();
  return { number: MOCK_B0 + Math.floor(ms / 2000), timestamp: MOCK_T0 + Math.floor(ms / 1000) };
}
// the arbiters, evaluated whenever the page reads the round
function mockTick() {
  const { timestamp, number } = mockHead();
  const c = mockChain;
  if (c.phase === 3) {
    c.commits = Math.min(c.maxCommits, Math.floor((timestamp - c.drawnAt) / 10));
    if (c.commits >= 6) {
      c.phase = 4;
      c.closeBlock = number;
    }
  }
  if (c.phase === 5 && c.revealAfter !== null && timestamp - c.promotedAt >= c.revealAfter) {
    c.phase = 6;
    c.evaluation = [[700000n, 300000n], 'QmJustification', true];
  }
}

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  const revert = (name, iface) =>
    actual.makeError('execution reverted', 'CALL_EXCEPTION', {
      action: 'estimateGas',
      data: iface.getError(name).selector,
      reason: null,
      transaction: {},
      invocation: null,
      revert: null,
    });

  class FakeBrowserProvider {
    async getNetwork() { return { chainId: mockChain.chainId }; }
    async getCode() { return '0x6080'; }
    async getBalance() { return 1000000000000000000n; }
    async getFeeData() { return { gasPrice: null, maxFeePerGas: 20000000n, maxPriorityFeePerGas: 1000000n }; }
    async getSigner() { return { isSigner: true, provider: this }; }
    async getBlock() { return mockHead(); }
  }

  class FakeContract {
    constructor(address, abi, runner) {
      this.target = address;
      this.runner = runner;
      this.interface = new actual.Interface(abi);
      const iface = this.interface;
      const c = mockChain;

      // ethers 6 refuses to send from a contract that is bound to a provider only.
      const requireSigner = () => {
        if (!runner?.isSigner) {
          throw actual.makeError('contract runner does not support sending transactions', 'UNSUPPORTED_OPERATION', {
            operation: 'sendTransaction',
          });
        }
      };

      this.maxTotalFee = async (maxFee, minFee, withBeacons, K, P) => {
        c.maxTotalFeeArgs = [maxFee, minFee, withBeacons, K, P];
        return maxFee * 18n;
      };
      this.ethOwed = async () => c.ethOwed;
      // the round's own jury; zero for an unknown round, like the contract
      this.getJury = async () => {
        const j = c.jury || { K: 0, M: 0, N: 0, P: 0, timeout: 0 };
        return [j.K, j.M, j.N, j.P, j.timeout].map(BigInt);
      };
      this.getEvaluation = async () => c.evaluation;
      this.getRoundInfo = async () => {
        mockTick();
        return [c.phase, MOCK_B0, '0x' + '00'.repeat(32), c.closeBlock, 0n, 0n, 0n, 0n, c.deadline, c.windowEnd, c.commits, MOCK_T0];
      };
      this.filters = { RequesterRefunded: (id) => ({ id }) };
      this.queryFilter = async () => [];
      this.requestAIEvaluationWithApproval = async (...args) => {
        requireSigner();
        const overrides = args.pop();
        c.sent.push({ fn: 'requestAIEvaluationWithApproval', args, overrides, signer: runner });
        c.jury = { ...args[9] };
        return {
          wait: async () => {
            c.phase = 1;
            c.minedAt = Date.now();
            return { logs: [iface.encodeEventLog('RequestAIEvaluation', [MOCK_AGG_ID, ['cid']])] };
          },
        };
      };

      const rules = {
        drawJury: () => {
          if (c.phase !== 1) throw revert('WrongPhase', iface);
          if (mockHead().number < MOCK_B0 + 2) throw revert('TooEarly', iface);
        },
        promote: () => {
          if (c.phase !== 4) throw revert('WrongPhase', iface);
          if (mockHead().number < c.closeBlock + 2) throw revert('TooEarly', iface);
        },
        closeCommits: () => {
          const { timestamp } = mockHead();
          if (c.phase !== 3 || timestamp <= c.windowEnd || c.commits < 5) throw revert('WrongPhase', iface);
        },
        settle: () => {
          if (c.phase < 3 || c.phase >= 7) throw revert('WrongPhase', iface);
          if (mockHead().timestamp <= c.deadline) throw revert('NotDue', iface);
        },
      };
      const effects = {
        drawJury: () => {
          const { timestamp } = mockHead();
          c.phase = 3;
          c.drawnAt = timestamp;
          c.windowEnd = timestamp + 155;
          c.deadline = timestamp + 300;
          c.ethOwed += 2n * MOCK_MAX_FEE;
          return [iface.encodeEventLog('JuryDrawn', [MOCK_AGG_ID, MOCK_WALLET, 2n * MOCK_MAX_FEE])];
        },
        promote: () => {
          c.phase = 5;
          c.promotedAt = mockHead().timestamp;
          c.ethOwed += MOCK_MAX_FEE;
          return [];
        },
        closeCommits: () => {
          c.phase = 4;
          c.closeBlock = mockHead().number;
          return [];
        },
        settle: () => {
          c.phase = 8;
          c.ethOwed += MOCK_REFUND;
          return [iface.encodeEventLog('RequesterRefunded', [MOCK_AGG_ID, MOCK_WALLET, MOCK_REFUND])];
        },
      };
      for (const fn of Object.keys(rules)) {
        const send = async (id, overrides) => {
          requireSigner();
          const error = c.wallet(fn);
          if (error) throw error;
          c.sent.push({ fn, args: [id], overrides, signer: runner });
          return {
            hash: MOCK_TX_HASH,
            wait: async () => {
              rules[fn]();
              return { status: 1, hash: MOCK_TX_HASH, logs: effects[fn]() };
            },
          };
        };
        send.estimateGas = async (id, overrides) => {
          c.lastEstimateFrom = overrides?.from;
          mockTick();
          rules[fn]();
          return 1_000_000n;
        };
        this[fn] = send;
      }
    }
  }

  return {
    ...actual,
    ethers: { ...actual.ethers, BrowserProvider: FakeBrowserProvider, JsonRpcProvider: FakeBrowserProvider, Contract: FakeContract },
  };
});

jest.mock('../App', () => ({ PAGES: { RESULTS: 'RESULTS' } }));
jest.mock('../utils/injectedProvider', () => ({ selectInjectedProvider: () => ({ isMetaMask: true }) }));
jest.mock('../utils/fetchUtils', () => ({ fetchWithRetry: jest.fn(), tryParseJustification: jest.fn() }));
jest.mock('../utils/packageUtils', () => ({ createQueryPackageArchive: jest.fn() }));
jest.mock('../utils/serverUtils', () => ({ uploadToServer: jest.fn() }));
jest.mock('../utils/contractDebugger', () => ({ ContractDebugger: jest.fn() }));
jest.mock('../services/modelProviderService', () => ({
  modelProviderService: { convertJuryNodesToManifestFormat: jest.fn(() => []) },
}));

/* ---------- harness ---------- */

const spies = {};

function Harness({ network = 'base', withBeacons = false, minFee = 0n, jury }) {
  const [transactionStatus, setTransactionStatus] = React.useState('');
  const [loadingResults, setLoadingResults] = React.useState(false);
  const [roundInfo, setRoundInfo] = React.useState(null);
  return (
    <RunQuery
      queryText="Is the sky blue?"
      outcomeLabels={['True', 'False']}
      supportingFiles={[]}
      ipfsCids={[]}
      juryNodes={[]}
      iterations={1}
      selectedMethod="ipfs"
      setSelectedMethod={() => {}}
      queryPackageFile={null}
      setQueryPackageFile={() => {}}
      queryPackageCid=""
      setQueryPackageCid={() => {}}
      isConnected
      setIsConnected={() => {}}
      walletAddress={MOCK_WALLET}
      setWalletAddress={() => {}}
      contractAddress={AGGREGATOR}
      transactionStatus={transactionStatus}
      setTransactionStatus={setTransactionStatus}
      roundInfo={roundInfo}
      setRoundInfo={setRoundInfo}
      loadingResults={loadingResults}
      setLoadingResults={setLoadingResults}
      uploadProgress={0}
      setUploadProgress={() => {}}
      setCurrentCid={() => {}}
      setPackageDetails={() => {}}
      setResultCid={spies.setResultCid}
      setJustification={spies.setJustification}
      setOutcomes={spies.setOutcomes}
      setResultTimestamp={() => {}}
      setCurrentPage={spies.setCurrentPage}
      hyperlinks={[]}
      setOutcomeLabels={spies.setOutcomeLabels}
      alpha={500}
      maxFee={MOCK_MAX_FEE}
      minFee={minFee}
      estimatedBaseCost={1000000000000n}
      maxFeeBasedScalingFactor={10}
      withBeacons={withBeacons}
      jury={jury}
      selectedClassId={128}
      selectedNetwork={network}
    />
  );
}

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

// Move the clock forward one second at a time, letting the page react after each step.
async function advance(seconds) {
  for (let s = 0; s < seconds; s++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await flush();
    });
  }
}

async function startQuery(props = {}) {
  const view = render(<Harness {...props} />);
  await act(flush);
  fireEvent.click(screen.getByRole('button', { name: 'Run Query' }));
  await advance(2); // the page sends the request and gets its confirmation
  return view;
}

const runButton = () => screen.getAllByRole('button').find((button) => button.classList.contains('primary'));
const sentFns = () => mockChain.sent.map((s) => s.fn);

beforeEach(() => {
  resetChain();
  window.localStorage.clear();
  Object.assign(spies, {
    setCurrentPage: jest.fn(),
    setOutcomes: jest.fn(),
    setJustification: jest.fn(),
    setResultCid: jest.fn(),
    setOutcomeLabels: jest.fn(),
  });
  // Create React App resets mock implementations before every test, so set them here.
  fetchWithRetry.mockResolvedValue({});
  tryParseJustification.mockResolvedValue('The jury agreed.');
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  global.fetch = jest.fn(() => Promise.resolve({ ok: true }));
  window.alert = jest.fn();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/* ---------- tests ---------- */

test('the request has the 10 v2 arguments, the default Small jury, and attaches the 5-argument quote', async () => {
  await startQuery({ minFee: 0n, withBeacons: false });

  const request = mockChain.sent[0];
  expect(request.fn).toBe('requestAIEvaluationWithApproval');
  expect(request.args).toHaveLength(10);
  const [cids, addendum, alpha, maxFee, minFee, baseCost, scaling, cls, withBeacons, jury] = request.args;
  expect(cids).toEqual(['QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH']);
  expect(addendum).toBe('');
  expect([alpha, maxFee, minFee, baseCost, scaling, cls, withBeacons]).toEqual([500, MOCK_MAX_FEE, 0n, 1000000000000n, 10, 128, false]);
  expect(jury).toEqual({ K: 6, M: 5, N: 4, P: 3, timeout: 300 });
  expect(mockChain.maxTotalFeeArgs).toEqual([MOCK_MAX_FEE, 0n, false, 6, 3]);
  expect(request.overrides.value).toBe(MOCK_MAX_FEE * 18n);
  expect(request.signer.isSigner).toBe(true);
  // the ABI encodes the jury as the tuple (uint8, uint8, uint8, uint8, uint40)
  const { Interface } = jest.requireActual('ethers');
  const { CONTRACT_ABI } = jest.requireActual('../utils/contractUtils');
  const iface = new Interface(CONTRACT_ABI);
  const data = iface.encodeFunctionData('requestAIEvaluationWithApproval', request.args);
  expect(iface.decodeFunctionData('requestAIEvaluationWithApproval', data)[9].toObject()).toEqual({ K: 6n, M: 5n, N: 4n, P: 3n, timeout: 300n });
});

test('the jury setting goes with the request and its quote (Jumbo, with beacons)', async () => {
  const jumbo = { K: 50, M: 38, N: 27, P: 17, timeout: 600 };
  render(<Harness jury={jumbo} withBeacons />);
  await act(flush);
  // the banner's quote before the contract is read uses the jury: 0.0001 x (50 + 3 x 17 + 2) + 0.0001 x 3
  expect(screen.getByTestId('request-jury')).toHaveTextContent('50/38/27/17, 600 s');
  fireEvent.click(screen.getByRole('button', { name: 'Run Query' }));
  await advance(2);

  const request = mockChain.sent[0];
  expect(request.args[8]).toBe(true);
  expect(request.args[9]).toEqual(jumbo);
  expect(mockChain.maxTotalFeeArgs).toEqual([MOCK_MAX_FEE, 0n, true, 50, 17]);
});

test('the page tells the user which wallet transactions follow and who earns what', async () => {
  render(<Harness />);
  await act(flush);
  const steps = screen.getByTestId('wallet-steps');
  expect(steps).toHaveTextContent('drawJury');
  expect(steps).toHaveTextContent('2 × the per-arbiter fee');
  expect(steps).toHaveTextContent('promote');
  expect(steps).toHaveTextContent('1 × the per-arbiter fee');
  expect(steps).toHaveTextContent('closeCommits');
  // the banner's default quote is the v2 formula for the Small jury: 0.0001 x (6 + 3 x 3) + 0.0001 x 3
  expect(screen.getByText(/Queries are paid in/)).toHaveTextContent('0.0018 ETH');
  expect(screen.getByTestId('request-jury')).toHaveTextContent('6/5/4/3, 300 s');
});

test('the wallet draws at B+2 and promotes at C+2, the timeline follows, and the result opens', async () => {
  await startQuery();
  expect(sentFns()).toEqual(['requestAIEvaluationWithApproval']); // nothing before block B+2

  await advance(6);
  expect(sentFns()).toEqual(['requestAIEvaluationWithApproval', 'drawJury']);
  expect(mockChain.sent[1].signer.isSigner).toBe(true);
  expect(mockChain.sent[1].overrides.gasLimit).toBe(1_500_000n);
  expect(mockChain.lastEstimateFrom).toBe(MOCK_WALLET);

  // the commit phase, with its commits and the round deadline
  await advance(25);
  const timeline = screen.getByTestId('round-timeline');
  expect(timeline).toHaveTextContent(MOCK_AGG_ID);
  expect(timeline).toHaveTextContent(/committed, 5 needed\)/);
  // the round's jury, read with getJury(aggId)
  expect(screen.getByTestId('round-jury')).toHaveTextContent('6 drawn, 5 promoted to reveal, 4 counted, 3 clustered; round timeout 300 s');
  expect(screen.getByTestId('round-deadline')).toHaveTextContent(/Round deadline in \d+ s/);
  expect(screen.getByRole('link', { name: 'drawJury' })).toHaveAttribute('href', `https://basescan.org/tx/${MOCK_TX_HASH}`);
  expect(runButton().textContent).toMatch(/\(\d+s\)/);

  // M+ commits close the window; promote at C+2, then the reveals finalize
  await advance(70);
  expect(sentFns()).toEqual(['requestAIEvaluationWithApproval', 'drawJury', 'promote']);
  await advance(30);

  expect(spies.setOutcomes).toHaveBeenCalledWith([700000, 300000]);
  expect(spies.setJustification).toHaveBeenLastCalledWith('The jury agreed.');
  expect(spies.setCurrentPage).toHaveBeenCalledWith('RESULTS');
  expect(screen.queryByTestId('timeout-notice')).toBeNull();
  expect(window.localStorage.getItem(PENDING_ROUND_KEY)).toBeNull();
});

test('declined draw: the notice offers the draw, and the button finishes the round', async () => {
  mockChain.wallet = (fn) =>
    fn === 'drawJury'
      ? jest.requireActual('ethers').makeError('user rejected action', 'ACTION_REJECTED', {
          action: 'sendTransaction',
          reason: 'rejected',
          info: { error: { code: 4001, message: 'User denied transaction signature.' } },
        })
      : undefined;
  await startQuery();
  await advance(6);

  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('The round is waiting for the jury draw.');
  expect(notice).toHaveTextContent('You declined the wallet transaction, so it was not sent.');
  expect(notice).toHaveTextContent(`Round ID: ${MOCK_AGG_ID}`);
  expect(spies.setCurrentPage).not.toHaveBeenCalled();
  expect(runButton().textContent).toBe('Run Query');
  // still open, so a reload can find it
  expect(JSON.parse(window.localStorage.getItem(PENDING_ROUND_KEY)).aggId).toBe(MOCK_AGG_ID);

  // The user presses the button and approves this time.
  mockChain.wallet = () => undefined;
  fireEvent.click(screen.getByRole('button', { name: 'Draw the jury (wallet transaction)' }));
  await advance(140);

  expect(sentFns()).toEqual(['requestAIEvaluationWithApproval', 'drawJury', 'promote']);
  expect(spies.setCurrentPage).toHaveBeenCalledWith('RESULTS');
  expect(screen.queryByTestId('timeout-notice')).toBeNull();
});

test('too few commits: the wallet settles after the deadline and the refund is shown', async () => {
  mockChain.maxCommits = 3;
  await startQuery();
  await advance(300);
  expect(sentFns()).toEqual(['requestAIEvaluationWithApproval', 'drawJury']); // no closeCommits with < M

  await advance(15);
  expect(sentFns()).toEqual(['requestAIEvaluationWithApproval', 'drawJury', 'settle']);

  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('No result: the round failed.');
  expect(notice).toHaveTextContent('in the commit phase');
  expect(notice).toHaveTextContent('Your wallet sent the transaction that settled it');
  expect(notice).toHaveTextContent('0.00108 ETH of your prepayment came back as prepay credit.');
  // the draw reward (0.0002) and the refund (0.00108) are both credit now
  expect(notice).toHaveTextContent('Your prepay credit is now 0.00128 ETH.');
  expect(screen.getByTestId('round-timeline')).toHaveTextContent('The round failed.');
  expect(spies.setCurrentPage).not.toHaveBeenCalled();
  expect(spies.setOutcomes).toHaveBeenLastCalledWith([]);
  expect(spies.setOutcomeLabels).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(PENDING_ROUND_KEY)).toBeNull();
});

test('after a reload the page offers to resume a round it was driving', async () => {
  // A round this browser started, already drawn and waiting for promotion.
  Object.assign(mockChain, { jury: { K: 8, M: 5, N: 4, P: 3, timeout: 300 }, phase: 4, minedAt: Date.now() - 200_000, closeBlock: MOCK_B0 + 90, deadline: MOCK_T0 + 400, revealAfter: 10 });
  window.localStorage.setItem(
    PENDING_ROUND_KEY,
    JSON.stringify({ aggId: MOCK_AGG_ID, contractAddress: AGGREGATOR, networkKey: 'base', withBeacons: false, account: MOCK_WALLET })
  );
  render(<Harness />);
  await act(flush);

  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('The round is still open.');
  expect(notice).toHaveTextContent('The page was closed or reloaded');
  expect(mockChain.sent).toHaveLength(0); // nothing is sent without the user asking

  fireEvent.click(screen.getByRole('button', { name: 'Resume the round' }));
  await advance(1);
  // the jury shown is the round's (getJury), not the page's current setting (Small)
  expect(screen.getByTestId('round-jury')).toHaveTextContent('8 drawn');
  await advance(19);

  expect(sentFns()).toEqual(['promote']);
  expect(spies.setCurrentPage).toHaveBeenCalledWith('RESULTS');
  expect(window.localStorage.getItem(PENDING_ROUND_KEY)).toBeNull();
});
