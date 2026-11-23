/**
 * The Run Query page, from "Run Query" to the end of the wait, against a fake chain.
 * These tests drive the real page and the real timeoutUtils; only ethers' provider and
 * contract classes, the wallet and the server calls are replaced.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import RunQuery from './RunQuery';
import { fetchWithRetry, tryParseJustification } from '../utils/fetchUtils';

const AGGREGATOR = '0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a';
const WALLET = '0x742F15ebE4fCcC794a39dbBc00e3C5700A7BEB8D';
const REQUEST_ID = '0x550c3efce479f5d364a86733cd47890d426214c55058f006cec0b26677c73608';
const TX_HASH = '0x' + 'ab'.repeat(32);
const REFUND = 1080000000000000n; // 0.00108 ETH

// The fake chain. Names start with "mock" so the jest.mock factories below may use them.
const mockChain = {};
function resetChain() {
  Object.assign(mockChain, {
    chainId: 8453n,
    timeoutSeconds: 300n,
    evaluation: [[], '', false],
    ethOwed: 0n,
    isFailed: false,
    estimateGas: async () => 1888985n,
    // What the wallet does with finalizeEvaluationTimeout: by default it is mined.
    sendFinalize: async (contract) => ({
      hash: TX_HASH,
      wait: async () => {
        mockChain.isFailed = true;
        mockChain.ethOwed = REFUND;
        return {
          status: 1,
          hash: TX_HASH,
          logs: [contract.interface.encodeEventLog('RequesterRefunded', [REQUEST_ID, WALLET, REFUND])],
        };
      },
    }),
    finalizeCalls: [],
  });
}

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');

  class FakeBrowserProvider {
    async getNetwork() { return { chainId: mockChain.chainId }; }
    async getCode() { return '0x6080'; }
    async getBalance() { return 1000000000000000000n; }
    async getFeeData() { return { gasPrice: null, maxFeePerGas: 20000000n, maxPriorityFeePerGas: 1000000n }; }
    async getSigner() { return { isSigner: true, provider: this }; }
  }

  class FakeContract {
    constructor(address, abi, runner) {
      this.target = address;
      this.runner = runner;
      this.interface = new actual.Interface(abi);

      // ethers 6 refuses to send from a contract that is bound to a provider only.
      const requireSigner = () => {
        if (!runner?.isSigner) {
          throw actual.makeError('contract runner does not support sending transactions', 'UNSUPPORTED_OPERATION', {
            operation: 'sendTransaction',
          });
        }
      };

      this.responseTimeoutSeconds = async () => mockChain.timeoutSeconds;
      this.maxTotalFee = async (fee) => fee * 12n;
      this.ethOwed = async () => mockChain.ethOwed;
      this.getEvaluation = async () => mockChain.evaluation;
      this.isFailed = async () => mockChain.isFailed;
      this.requestAIEvaluationWithApproval = async () => {
        requireSigner();
        return {
          wait: async () => ({
            logs: [this.interface.encodeEventLog('RequestAIEvaluation', [mockChain.requestId, ['cid']])],
          }),
        };
      };
      const finalize = async (requestId, overrides) => {
        requireSigner();
        mockChain.finalizeCalls.push({ requestId, overrides, signer: runner });
        return mockChain.sendFinalize(this);
      };
      finalize.estimateGas = async () => mockChain.estimateGas();
      this.finalizeEvaluationTimeout = finalize;
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

function Harness({ network }) {
  const [transactionStatus, setTransactionStatus] = React.useState('');
  const [loadingResults, setLoadingResults] = React.useState(false);
  const [timeoutInfo, setTimeoutInfo] = React.useState(null);
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
      walletAddress={WALLET}
      setWalletAddress={() => {}}
      contractAddress={AGGREGATOR}
      transactionStatus={transactionStatus}
      setTransactionStatus={setTransactionStatus}
      timeoutInfo={timeoutInfo}
      setTimeoutInfo={setTimeoutInfo}
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
      maxFee={100000000000000n}
      estimatedBaseCost={1000000000000n}
      maxFeeBasedScalingFactor={10}
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

async function startQuery({ network = 'base' } = {}) {
  render(<Harness network={network} />);
  await act(flush);
  fireEvent.click(screen.getByRole('button', { name: 'Run Query' }));
  await advance(2); // the page sends the request and gets its confirmation
}

const runButton = () => screen.getAllByRole('button').find((button) => button.classList.contains('primary'));
const countdown = () => Number(/\((\d+)s\)/.exec(runButton().textContent)?.[1]);

beforeEach(() => {
  resetChain();
  mockChain.requestId = REQUEST_ID;
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

test('the countdown starts at the aggregator timeout: 300 s on Base', async () => {
  await startQuery({ network: 'base' });

  expect(runButton().textContent).toMatch(/Waiting for evaluation results/);
  expect(countdown()).toBeGreaterThanOrEqual(297);
  expect(countdown()).toBeLessThanOrEqual(300);
});

test('the countdown starts at the aggregator timeout: 900 s on Base Sepolia', async () => {
  mockChain.chainId = 84532n;
  mockChain.timeoutSeconds = 900n;
  await startQuery({ network: 'base_sepolia' });

  expect(countdown()).toBeGreaterThanOrEqual(897);
  expect(countdown()).toBeLessThanOrEqual(900);

  // The old page gave up after 300 s. Now it is still waiting, and has sent nothing.
  await advance(400);
  expect(runButton().textContent).toMatch(/Waiting for evaluation results/);
  expect(countdown()).toBeGreaterThanOrEqual(497);
  expect(countdown()).toBeLessThanOrEqual(500);
  expect(mockChain.finalizeCalls).toHaveLength(0);
  expect(screen.queryByTestId('timeout-notice')).toBeNull();
});

test('fulfilled: a result that arrives during the wait opens the Results page', async () => {
  await startQuery();
  await advance(40);
  expect(spies.setCurrentPage).not.toHaveBeenCalled();

  mockChain.evaluation = [[700000n, 300000n], 'QmJustification', true];
  await advance(6);

  expect(spies.setOutcomes).toHaveBeenCalledWith([700000, 300000]);
  expect(spies.setResultCid).toHaveBeenCalledWith('QmJustification');
  expect(spies.setJustification).toHaveBeenLastCalledWith('The jury agreed.');
  expect(spies.setCurrentPage).toHaveBeenCalledWith('RESULTS');
  expect(mockChain.finalizeCalls).toHaveLength(0);
  expect(screen.queryByTestId('timeout-notice')).toBeNull();
});

test('timed out and finalized: the wallet closes the round and the refund is shown', async () => {
  await startQuery();
  await advance(299);
  expect(mockChain.finalizeCalls).toHaveLength(0); // nothing is sent before the timeout

  await advance(8);

  // Sent once, by the wallet's signer, with a gas limit that is enough.
  expect(mockChain.finalizeCalls).toHaveLength(1);
  expect(mockChain.finalizeCalls[0].requestId).toBe(REQUEST_ID);
  expect(mockChain.finalizeCalls[0].signer.isSigner).toBe(true);
  expect(mockChain.finalizeCalls[0].overrides.gasLimit).toBeGreaterThanOrEqual(3000000n);

  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('No result arrived. The round is closed.');
  expect(notice).toHaveTextContent('No result arrived within 300 seconds.');
  expect(notice).toHaveTextContent('Your wallet sent the transaction that closes the round');
  expect(notice).toHaveTextContent('0.00108 ETH of your prepayment came back as prepay credit.');
  expect(notice).toHaveTextContent('Your prepay credit is now 0.00108 ETH.');
  expect(screen.getByRole('link', { name: 'view transaction' })).toHaveAttribute('href', `https://basescan.org/tx/${TX_HASH}`);
  expect(notice).not.toHaveTextContent('FAILED');

  // The page stays on Run Query, is ready for another query, and keeps the query's labels.
  expect(spies.setCurrentPage).not.toHaveBeenCalled();
  expect(spies.setOutcomes).toHaveBeenLastCalledWith([]);
  expect(spies.setOutcomeLabels).not.toHaveBeenCalled();
  expect(runButton().textContent).toBe('Run Query');
});

test('user declined: the page says the round is still open and how to close it, and can retry', async () => {
  const mined = mockChain.sendFinalize;
  mockChain.sendFinalize = async () => {
    const { makeError } = jest.requireActual('ethers');
    throw makeError('user rejected action', 'ACTION_REJECTED', {
      action: 'sendTransaction',
      reason: 'rejected',
      info: { error: { code: 4001, message: 'User denied transaction signature.' } },
    });
  };
  await startQuery();
  await advance(307);

  expect(mockChain.finalizeCalls).toHaveLength(1);
  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('No result arrived. The round is still open.');
  expect(notice).toHaveTextContent('You declined the transaction that closes the round, so it was not sent.');
  expect(notice).toHaveTextContent('the unspent part of your prepayment stays reserved in it');
  expect(notice).toHaveTextContent('finalizeEvaluationTimeout');
  expect(notice).toHaveTextContent(AGGREGATOR);
  expect(notice).toHaveTextContent(`Request ID: ${REQUEST_ID}`);
  expect(notice).not.toHaveTextContent('came back as prepay credit');
  expect(spies.setCurrentPage).not.toHaveBeenCalled();

  // Later: the user presses the button and approves this time.
  mockChain.sendFinalize = mined;
  fireEvent.click(screen.getByRole('button', { name: 'Close the round now' }));
  await advance(1);

  expect(mockChain.finalizeCalls).toHaveLength(2);
  expect(mockChain.finalizeCalls[1].signer.isSigner).toBe(true);
  expect(screen.getByTestId('timeout-notice')).toHaveTextContent('No result arrived. The round is closed.');
  expect(screen.getByTestId('timeout-notice')).toHaveTextContent('0.00108 ETH of your prepayment came back');
  expect(screen.queryByRole('button', { name: 'Close the round now' })).toBeNull();
});

test('a round that completes just before the closing call is shown as a result', async () => {
  // The last answer lands after the final poll: the dry run reverts with AggregationComplete.
  mockChain.estimateGas = async () => {
    const { makeError, id } = jest.requireActual('ethers');
    mockChain.evaluation = [[550000n, 450000n], 'QmLate', true];
    throw makeError('execution reverted', 'CALL_EXCEPTION', {
      action: 'estimateGas',
      data: id('AggregationComplete()').slice(0, 10),
      reason: null,
      transaction: {},
      invocation: null,
      revert: null,
    });
  };
  await startQuery();
  await advance(307);

  expect(mockChain.finalizeCalls).toHaveLength(0);
  expect(spies.setOutcomes).toHaveBeenCalledWith([550000, 450000]);
  expect(spies.setCurrentPage).toHaveBeenCalledWith('RESULTS');
  expect(screen.queryByTestId('timeout-notice')).toBeNull();
});

test('a round another account already closed is reported as closed, without a transaction', async () => {
  mockChain.estimateGas = async () => {
    const { makeError, id } = jest.requireActual('ethers');
    mockChain.isFailed = true;
    mockChain.ethOwed = REFUND;
    throw makeError('execution reverted', 'CALL_EXCEPTION', {
      action: 'estimateGas',
      data: id('AggregationComplete()').slice(0, 10),
      reason: null,
      transaction: {},
      invocation: null,
      revert: null,
    });
  };
  await startQuery();
  await advance(307);

  expect(mockChain.finalizeCalls).toHaveLength(0);
  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('No result arrived. The round is closed.');
  expect(notice).toHaveTextContent('Another account had already closed the round');
  expect(notice).toHaveTextContent('Your prepay credit is now 0.00108 ETH.');
});
