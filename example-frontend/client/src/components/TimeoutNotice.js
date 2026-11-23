// src/components/TimeoutNotice.js
import React from 'react';
import { formatEther } from 'ethers';
import { PHASE_NAMES, STEP_FUNCTIONS } from '../utils/timeoutUtils';

/**
 * What the Run Query page shows when a round ended without a result, or stopped
 * waiting for a call the user's wallet did not make. It says what happened on the
 * blockchain: whether the round failed and where its unspent prepay went, or which
 * call the round is waiting for, who may make it, and who earns what.
 *
 * `info.outcome` is the object driveRound() (utils/timeoutUtils.js) resolves with, or
 * { status: 'stalled', step: null, reason: 'page-left' } for a round the page found in
 * the browser's storage after a reload.
 */

const NOT_SENT_REASONS = {
  declined: 'You declined the wallet transaction, so it was not sent.',
  'no-wallet': 'The page could not reach your wallet, so the transaction was not sent.',
  'send-failed': 'The transaction could not be sent.',
  'tx-failed': 'The transaction was sent, but it did not succeed.',
  'check-failed': 'The page could not check the round on the blockchain, so it stopped driving it.',
  'page-left': 'The page was closed or reloaded while this round was running, so nothing has moved it on since.',
};

// What each call does and who earns what (ReputationAggregator v2).
const STEPS = {
  draw: {
    waiting: 'the jury draw',
    button: 'Draw the jury',
    explain: (
      <>
        <code>drawJury</code> draws the jury from block B+2 of the request. Within 30 seconds of the request only
        you earn the draw reward (2 × the per-arbiter fee, added to your prepay credit); after that anyone may draw
        and earns it. An undrawn round never times out: a day after the request it can only be cancelled, and its
        prepay goes to the treasury.
      </>
    ),
  },
  'beacon-draw': {
    waiting: 'the second jury draw (after the beacons)',
    button: 'Draw the jury',
    explain: (
      <>
        This round asked for beacons. The first <code>drawJury</code> started the beacon stage; a second{' '}
        <code>drawJury</code> draws the jury once the beacon values are in. Within 30 seconds of the last needed
        beacon only you earn the draw reward (2 × the per-arbiter fee); after that anyone may draw and earns it. If
        the beacon values do not arrive, the round fails and its prepay goes to the treasury.
      </>
    ),
  },
  close: {
    waiting: 'the commit phase to be closed',
    button: 'Close the commit phase',
    explain: (
      <>
        Enough arbiters committed, but not so many that the commit window closed by itself. <code>closeCommits</code>{' '}
        closes it; there is no reward. If nobody closes it before the deadline, the round fails and its unspent
        prepay goes to the treasury, not back to you.
      </>
    ),
  },
  promote: {
    waiting: 'the commits to be promoted',
    button: 'Promote the commits',
    explain: (
      <>
        <code>promote</code> picks the commits the arbiters reveal. Whoever calls it earns the promote reward (1 × the
        per-arbiter fee). If nobody promotes before the deadline, the round fails and its unspent prepay goes to the
        treasury, not back to you.
      </>
    ),
  },
  settle: {
    waiting: 'settlement',
    button: 'Settle the round',
    explain: (
      <>
        The round passed its deadline without a result. <code>settle</code> closes it and credits the unspent part
        of your prepayment to your prepay credit; there is no reward. Anyone may call it, and new requests settle
        due rounds too.
      </>
    ),
  },
};

const EXPIRED = {
  'close-missed':
    'Enough arbiters committed, but the commit phase was not closed before the deadline. The round will fail, and its unspent prepay goes to the treasury, so settling it would not return anything to you.',
  'promote-missed':
    'The commit phase closed, but nobody promoted the commits before the deadline. The round will fail, and its unspent prepay goes to the treasury, so settling it would not return anything to you.',
  'draw-expired':
    'More than a day has passed since the request, so the jury can no longer be drawn. The round can only be cancelled (cancelUnsealed), which sends its prepay to the treasury.',
  'seed-expired':
    'The block the draw depends on is too old to read, so the round can no longer move on. It can only be cancelled (cancelUnsealed), which sends its prepay to the treasury.',
};

const boxStyle = (open) => ({
  backgroundColor: open ? '#fee' : '#fff8e1',
  border: `2px solid ${open ? '#f88' : '#e0b84c'}`,
  borderRadius: '8px',
  padding: '16px 20px',
  margin: '20px 0',
  textAlign: 'left',
  fontSize: '14px',
  color: '#333',
});

const codeStyle = { wordBreak: 'break-all', fontSize: '13px' };

function TimeoutNotice({ info, ethCredit = 0n, onResume, busy = false, busyStatus = '', disabled = false }) {
  if (!info?.outcome) return null;
  const { outcome, aggId, contractAddress, explorerUrl } = info;
  const stalled = outcome.status === 'stalled';

  const txLink = outcome.txHash ? (
    <>
      {' '}
      (
      <a href={`${explorerUrl}/tx/${outcome.txHash}`} target="_blank" rel="noopener noreferrer">
        view transaction
      </a>
      )
    </>
  ) : null;

  const creditSentence =
    ethCredit > 0n ? (
      <>
        {' '}
        Your prepay credit is now <strong>{formatEther(ethCredit)} ETH</strong>. It is applied to your next query
        automatically, and the "Withdraw credit" button sends it to your wallet.
      </>
    ) : null;

  const roundId = (
    <p style={{ margin: '0 0 12px 0' }}>
      Round ID: <code style={codeStyle}>{aggId}</code>
    </p>
  );

  let heading;
  let body;
  if (outcome.status === 'failed') {
    const where =
      outcome.failedPhase && PHASE_NAMES[outcome.failedPhase] && PHASE_NAMES[outcome.failedPhase] !== 'unknown'
        ? ` in the ${PHASE_NAMES[outcome.failedPhase]} phase`
        : '';
    const refund = outcome.refund;
    heading = 'No result: the round failed.';
    body = (
      <>
        <p style={{ margin: '0 0 8px 0' }}>
          The round ended{where} without a result.{' '}
          {outcome.settledBy === 'user' ? (
            <>Your wallet sent the transaction that settled it{txLink}.</>
          ) : (
            <>Your wallet did not need to send a transaction to close it.</>
          )}
        </p>
        <p style={{ margin: 0 }}>
          {!refund ? (
            <>The page could not read where the unspent part of the prepayment went.</>
          ) : refund.amount === 0n ? (
            <>Nothing was left of the prepayment to return.</>
          ) : refund.toRequester ? (
            <>
              <strong>{formatEther(refund.amount)} ETH</strong> of your prepayment came back as prepay credit.
            </>
          ) : (
            <>
              The unspent <strong>{formatEther(refund.amount)} ETH</strong> went to the treasury, not back to you: a
              round that fails this way gives no refund, so that a refund cannot be used as a free re-roll of the
              jury.
            </>
          )}
          {creditSentence}
        </p>
      </>
    );
  } else if (outcome.status === 'cancelled') {
    heading = 'No result: the round was cancelled.';
    body = (
      <p style={{ margin: 0 }}>
        The jury was never drawn, and the round was cancelled. Its prepay went to the treasury.{creditSentence}
      </p>
    );
  } else if (outcome.status === 'expired') {
    heading = 'No result: the round can no longer finish.';
    body = (
      <>
        <p style={{ margin: '0 0 8px 0' }}>{EXPIRED[outcome.reason] || EXPIRED['promote-missed']}</p>
        {roundId}
      </>
    );
  } else if (stalled) {
    const step = STEPS[outcome.step];
    heading = step ? `The round is waiting for ${step.waiting}.` : 'The round is still open.';
    body = (
      <>
        <p style={{ margin: '0 0 8px 0' }}>
          {NOT_SENT_REASONS[outcome.reason] || NOT_SENT_REASONS['send-failed']}
          {txLink}
          {outcome.errorMessage ? <> Details: {outcome.errorMessage}</> : null}
        </p>
        {step ? <p style={{ margin: '0 0 8px 0' }}>{step.explain}</p> : null}
        <p style={{ margin: '0 0 8px 0' }}>
          The button below picks the round up where it is: the page checks each call with a free dry run, and your
          wallet is asked to confirm only a call that will succeed. You can also call{' '}
          <code>{step ? STEP_FUNCTIONS[outcome.step] : 'drawJury, closeCommits, promote or settle'}</code> with the
          round ID on the aggregator contract{' '}
          <a href={`${explorerUrl}/address/${contractAddress}`} target="_blank" rel="noopener noreferrer">
            <code style={codeStyle}>{contractAddress}</code>
          </a>{' '}
          from any wallet.
        </p>
        {roundId}
        <button
          className="secondary"
          onClick={onResume}
          disabled={busy || disabled}
          style={{ padding: '6px 14px', fontSize: '14px', cursor: busy || disabled ? 'default' : 'pointer' }}
        >
          {busy ? 'Working on the round…' : step ? `${step.button} (wallet transaction)` : 'Resume the round'}
        </button>
        {busy && busyStatus ? <span style={{ marginLeft: '10px', color: '#666' }}>{busyStatus}</span> : null}
      </>
    );
  } else {
    return null;
  }

  return (
    <div style={boxStyle(stalled)} role="alert" data-testid="timeout-notice">
      <h3 style={{ color: stalled ? '#d44' : '#8a6100', margin: '0 0 10px 0' }}>{heading}</h3>
      {body}
    </div>
  );
}

export default TimeoutNotice;
