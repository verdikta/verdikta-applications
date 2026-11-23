import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TimeoutNotice from './TimeoutNotice';

const REQUEST_ID = '0x550c3efce479f5d364a86733cd47890d426214c55058f006cec0b26677c73608';
const AGGREGATOR = '0xe8a385E473EA710c5a88Cc72681a16a26fe380e4';
const TX_HASH = '0x' + 'ab'.repeat(32);

const info = (outcome) => ({
  requestId: REQUEST_ID,
  contractAddress: AGGREGATOR,
  networkKey: 'base_sepolia',
  explorerUrl: 'https://sepolia.basescan.org',
  timeoutSeconds: 900,
  outcome,
});

const open = (reason, extra = {}) => ({ status: 'timed-out', round: 'open', reason, ...extra });

test('renders nothing when there is no timeout to report', () => {
  const { container } = render(<TimeoutNotice info={null} />);
  expect(container).toBeEmptyDOMElement();
});

test('closed by the user: states the wait, the transaction and the refund', () => {
  render(
    <TimeoutNotice
      info={info({ status: 'timed-out', round: 'closed', closedBy: 'user', txHash: TX_HASH, refundWei: 1080000000000000n })}
      ethCredit={2040000000000000n}
    />
  );
  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('No result arrived. The round is closed.');
  expect(notice).toHaveTextContent('No result arrived within 900 seconds.');
  expect(notice).toHaveTextContent('0.00108 ETH of your prepayment came back as prepay credit.');
  expect(notice).toHaveTextContent('Your prepay credit is now 0.00204 ETH.');
  expect(screen.getByRole('link', { name: 'view transaction' })).toHaveAttribute(
    'href',
    `https://sepolia.basescan.org/tx/${TX_HASH}`
  );
  expect(screen.queryByRole('button')).toBeNull();
});

test('closed by the user with nothing left to return', () => {
  render(<TimeoutNotice info={info({ status: 'timed-out', round: 'closed', closedBy: 'user', txHash: TX_HASH, refundWei: 0n })} />);
  expect(screen.getByTestId('timeout-notice')).toHaveTextContent('Nothing was left of the prepayment to return.');
});

test('closed by the user when the receipt could not be read: no amount is claimed', () => {
  render(<TimeoutNotice info={info({ status: 'timed-out', round: 'closed', closedBy: 'user', txHash: TX_HASH, refundWei: null })} />);
  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('The unspent part of your prepayment came back as prepay credit.');
  expect(notice).not.toHaveTextContent('ETH of your prepayment');
});

test.each([
  ['declined', 'You declined the transaction that closes the round, so it was not sent.'],
  ['not-timed-out-yet', 'The network does not count the round as timed out yet'],
  ['no-wallet', 'The page could not reach your wallet'],
  ['send-failed', 'The transaction that closes the round could not be sent.'],
  ['tx-failed', 'The transaction that closes the round was sent, but it did not succeed.'],
  ['check-failed', 'The page could not check the round on the blockchain'],
])('still open (%s): says why, that the round is open, and how to close it', (reason, sentence) => {
  const onCloseRound = jest.fn();
  render(<TimeoutNotice info={info(open(reason))} onCloseRound={onCloseRound} />);

  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('No result arrived. The round is still open.');
  expect(notice).toHaveTextContent(sentence);
  expect(notice).toHaveTextContent('the unspent part of your prepayment stays reserved in it');
  expect(notice).toHaveTextContent(`Request ID: ${REQUEST_ID}`);
  expect(notice).toHaveTextContent(AGGREGATOR);
  expect(notice).not.toHaveTextContent('came back as prepay credit');

  fireEvent.click(screen.getByRole('button', { name: 'Close the round now' }));
  expect(onCloseRound).toHaveBeenCalledTimes(1);
});

test('still open: shows the error detail and the failed transaction when there is one', () => {
  render(<TimeoutNotice info={info(open('tx-failed', { txHash: TX_HASH, errorMessage: 'transaction execution reverted' }))} />);
  const notice = screen.getByTestId('timeout-notice');
  expect(notice).toHaveTextContent('Details: transaction execution reverted');
  expect(screen.getByRole('link', { name: 'view transaction' })).toHaveAttribute(
    'href',
    `https://sepolia.basescan.org/tx/${TX_HASH}`
  );
});

test('the button is disabled while a closing attempt or another query is running', () => {
  const { rerender } = render(<TimeoutNotice info={info(open('declined'))} closing closeStatus="Checking the round..." />);
  expect(screen.getByRole('button', { name: 'Closing the round…' })).toBeDisabled();
  expect(screen.getByTestId('timeout-notice')).toHaveTextContent('Checking the round...');

  rerender(<TimeoutNotice info={info(open('declined'))} disabled />);
  expect(screen.getByRole('button', { name: 'Close the round now' })).toBeDisabled();
});
