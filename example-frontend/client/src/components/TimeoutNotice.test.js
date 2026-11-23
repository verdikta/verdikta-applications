import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TimeoutNotice from './TimeoutNotice';
import RoundTimeline from './RoundTimeline';

const AGG_ID = '0x' + '0'.repeat(63) + '7';
const AGGREGATOR = '0x000000000000000000000000000000000000dEaD'; // any address: none is deployed for v2 yet
const TX_HASH = '0x' + 'ab'.repeat(32);

const info = (outcome, extra = {}) => ({
  aggId: AGG_ID,
  contractAddress: AGGREGATOR,
  networkKey: 'base_sepolia',
  explorerUrl: 'https://sepolia.basescan.org',
  withBeacons: false,
  outcome,
  ...extra,
});

const stalled = (step, reason, extra = {}) => ({ status: 'stalled', step, reason, ...extra });

test('renders nothing when there is nothing to report', () => {
  const { container } = render(<TimeoutNotice info={null} />);
  expect(container).toBeEmptyDOMElement();
  render(<TimeoutNotice info={info(null)} />);
  expect(screen.queryByTestId('timeout-notice')).toBeNull();
});

describe('a failed round', () => {
  test('settled by the user, refund to the user: states the transaction and the credit', () => {
    render(
      <TimeoutNotice
        info={info({
          status: 'failed',
          failedPhase: 5,
          settledBy: 'user',
          txHash: TX_HASH,
          refund: { amount: 1080000000000000n, toRequester: true },
        })}
        ethCredit={2040000000000000n}
      />
    );
    const notice = screen.getByTestId('timeout-notice');
    expect(notice).toHaveTextContent('No result: the round failed.');
    expect(notice).toHaveTextContent('The round ended in the reveal phase without a result.');
    expect(notice).toHaveTextContent('Your wallet sent the transaction that settled it');
    expect(notice).toHaveTextContent('0.00108 ETH of your prepayment came back as prepay credit.');
    expect(notice).toHaveTextContent('Your prepay credit is now 0.00204 ETH.');
    expect(screen.getByRole('link', { name: 'view transaction' })).toHaveAttribute(
      'href',
      `https://sepolia.basescan.org/tx/${TX_HASH}`
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('refund to the treasury: says it did not come back, and why', () => {
    render(
      <TimeoutNotice
        info={info({ status: 'failed', failedPhase: 2, settledBy: 'other', refund: { amount: 1500000000000000n, toRequester: false } })}
      />
    );
    const notice = screen.getByTestId('timeout-notice');
    expect(notice).toHaveTextContent('in the beacons phase');
    expect(notice).toHaveTextContent('Your wallet did not need to send a transaction');
    expect(notice).toHaveTextContent('The unspent 0.0015 ETH went to the treasury, not back to you');
    expect(notice).toHaveTextContent('free re-roll');
  });

  test('nothing left, or the refund could not be read: no amount is claimed', () => {
    const { rerender } = render(
      <TimeoutNotice info={info({ status: 'failed', settledBy: 'other', refund: { amount: 0n, toRequester: true } })} />
    );
    expect(screen.getByTestId('timeout-notice')).toHaveTextContent('Nothing was left of the prepayment to return.');
    rerender(<TimeoutNotice info={info({ status: 'failed', settledBy: 'other', refund: null })} />);
    expect(screen.getByTestId('timeout-notice')).toHaveTextContent('could not read where the unspent part');
    expect(screen.getByTestId('timeout-notice')).not.toHaveTextContent('ETH of your prepayment');
  });
});

test('cancelled and expired rounds offer no button', () => {
  const { rerender } = render(<TimeoutNotice info={info({ status: 'cancelled' })} />);
  expect(screen.getByTestId('timeout-notice')).toHaveTextContent('The jury was never drawn');
  expect(screen.queryByRole('button')).toBeNull();

  rerender(<TimeoutNotice info={info({ status: 'expired', reason: 'promote-missed' })} />);
  expect(screen.getByTestId('timeout-notice')).toHaveTextContent('nobody promoted the commits before the deadline');
  expect(screen.getByTestId('timeout-notice')).toHaveTextContent('goes to the treasury');
  expect(screen.queryByRole('button')).toBeNull();

  rerender(<TimeoutNotice info={info({ status: 'expired', reason: 'draw-expired' })} />);
  expect(screen.getByTestId('timeout-notice')).toHaveTextContent('More than a day has passed since the request');
});

describe('a round waiting for a call', () => {
  test.each([
    ['draw', 'The round is waiting for the jury draw.', 'Draw the jury (wallet transaction)', 'drawJury', '2 × the per-arbiter fee'],
    ['beacon-draw', 'the second jury draw', 'Draw the jury (wallet transaction)', 'drawJury', 'beacon'],
    ['close', 'the commit phase to be closed', 'Close the commit phase (wallet transaction)', 'closeCommits', 'goes to the treasury'],
    ['promote', 'the commits to be promoted', 'Promote the commits (wallet transaction)', 'promote', '1 × the per-arbiter fee'],
    ['settle', 'The round is waiting for settlement.', 'Settle the round (wallet transaction)', 'settle', 'credits the unspent part'],
  ])('%s: says what is missing, who earns what, and offers the call', (step, heading, button, fn, earn) => {
    const onResume = jest.fn();
    render(<TimeoutNotice info={info(stalled(step, 'declined'))} onResume={onResume} />);
    const notice = screen.getByTestId('timeout-notice');
    expect(notice).toHaveTextContent(heading);
    expect(notice).toHaveTextContent('You declined the wallet transaction, so it was not sent.');
    expect(notice).toHaveTextContent(earn);
    expect(notice).toHaveTextContent(fn);
    expect(notice).toHaveTextContent(`Round ID: ${AGG_ID}`);
    expect(notice).toHaveTextContent(AGGREGATOR);
    expect(notice).not.toHaveTextContent('finalizeEvaluationTimeout');

    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['no-wallet', 'The page could not reach your wallet'],
    ['send-failed', 'The transaction could not be sent.'],
    ['tx-failed', 'The transaction was sent, but it did not succeed.'],
    ['check-failed', 'The page could not check the round on the blockchain'],
  ])('reason %s is stated', (reason, sentence) => {
    render(<TimeoutNotice info={info(stalled('promote', reason))} />);
    expect(screen.getByTestId('timeout-notice')).toHaveTextContent(sentence);
  });

  test('after a reload: offers to resume a round whose next step is unknown', () => {
    const onResume = jest.fn();
    render(<TimeoutNotice info={info(stalled(null, 'page-left'))} onResume={onResume} />);
    const notice = screen.getByTestId('timeout-notice');
    expect(notice).toHaveTextContent('The round is still open.');
    expect(notice).toHaveTextContent('The page was closed or reloaded while this round was running');
    fireEvent.click(screen.getByRole('button', { name: 'Resume the round' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test('shows the error detail and the failed transaction when there is one', () => {
    render(<TimeoutNotice info={info(stalled('draw', 'tx-failed', { txHash: TX_HASH, errorMessage: 'transaction execution reverted' }))} />);
    expect(screen.getByTestId('timeout-notice')).toHaveTextContent('Details: transaction execution reverted');
    expect(screen.getByRole('link', { name: 'view transaction' })).toHaveAttribute('href', `https://sepolia.basescan.org/tx/${TX_HASH}`);
  });

  test('the button is disabled while the round is being worked on or another query runs', () => {
    const { rerender } = render(<TimeoutNotice info={info(stalled('draw', 'declined'))} busy busyStatus="Checking the round..." />);
    expect(screen.getByRole('button', { name: 'Working on the round…' })).toBeDisabled();
    expect(screen.getByTestId('timeout-notice')).toHaveTextContent('Checking the round...');

    rerender(<TimeoutNotice info={info(stalled('draw', 'declined'))} disabled />);
    expect(screen.getByRole('button', { name: 'Draw the jury (wallet transaction)' })).toBeDisabled();
  });
});

describe('RoundTimeline', () => {
  const round = (phase, extra = {}) => ({ phase, commits: 0, deadline: 0, ...extra });

  test('renders nothing before the round is read', () => {
    const { container } = render(<RoundTimeline info={info(null)} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('marks the phases done, current and to come, with the commits and the deadline', () => {
    render(
      <RoundTimeline
        info={info(null, {
          round: round(3, { commits: 4 }),
          deadlineMs: 1_000_000 + 250_000,
          steps: [{ step: 'draw', txHash: TX_HASH, rewardWei: 200000000000000n }],
        })}
        nowMs={1_000_000}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'active', 'pending', 'pending', 'pending']);
    expect(items[1]).toHaveTextContent('Commit');
    expect(items[1]).toHaveTextContent('(4 committed)');
    expect(screen.getByTestId('round-deadline')).toHaveTextContent('Round deadline in 250 s');
    expect(screen.getByRole('link', { name: 'drawJury' })).toHaveAttribute('href', `https://sepolia.basescan.org/tx/${TX_HASH}`);
    expect(screen.getByTestId('round-timeline')).toHaveTextContent('+0.0002 ETH credit');
  });

  test('shows the beacon phase only for beacon rounds, and a failed round', () => {
    const { rerender } = render(<RoundTimeline info={info(null, { withBeacons: true, round: round(2) })} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getAllByRole('listitem')[1]).toHaveAttribute('data-state', 'active');

    rerender(<RoundTimeline info={info(null, { round: round(8) })} />);
    expect(screen.getByTestId('round-timeline')).toHaveTextContent('The round failed.');
    expect(screen.queryByTestId('round-deadline')).toBeNull();
  });
});
