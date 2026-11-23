// src/components/TimeoutNotice.js
import React from 'react';
import { formatEther } from 'ethers';

/**
 * What the Run Query page shows when no result arrived within the aggregator's timeout.
 * It says what actually happened on the blockchain: whether the round was closed, by
 * whom, what came back as prepay credit, and, when the round is still open, how to
 * close it.
 *
 * `info.outcome` is the object timeoutUtils resolves with (status 'timed-out').
 */

const NOT_SENT_REASONS = {
  declined: 'You declined the transaction that closes the round, so it was not sent.',
  'not-timed-out-yet':
    'The network does not count the round as timed out yet, so the transaction that closes it was not sent.',
  'no-wallet': 'The page could not reach your wallet, so the transaction that closes the round was not sent.',
  'send-failed': 'The transaction that closes the round could not be sent.',
  'tx-failed': 'The transaction that closes the round was sent, but it did not succeed.',
  'check-failed':
    'The page could not check the round on the blockchain, so the transaction that closes it was not sent.',
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

function TimeoutNotice({ info, ethCredit = 0n, onCloseRound, closing = false, closeStatus = '', disabled = false }) {
  if (!info?.outcome) return null;
  const { outcome, requestId, contractAddress, explorerUrl, timeoutSeconds } = info;
  const open = outcome.round === 'open';

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
        Your prepay credit is now <strong>{formatEther(ethCredit)} ETH</strong>. It is applied to your next
        query automatically, and the "Withdraw credit" button sends it to your wallet.
      </>
    ) : null;

  const waited = `No result arrived within ${timeoutSeconds} seconds.`;

  return (
    <div style={boxStyle(open)} role="alert" data-testid="timeout-notice">
      <h3 style={{ color: open ? '#d44' : '#8a6100', margin: '0 0 10px 0' }}>
        {open ? 'No result arrived. The round is still open.' : 'No result arrived. The round is closed.'}
      </h3>

      {!open && outcome.closedBy === 'user' && (
        <>
          <p style={{ margin: '0 0 8px 0' }}>
            {waited} Your wallet sent the transaction that closes the round{txLink}.
          </p>
          <p style={{ margin: 0 }}>
            {outcome.refundWei === null || outcome.refundWei === undefined ? (
              <>The unspent part of your prepayment came back as prepay credit.</>
            ) : outcome.refundWei > 0n ? (
              <>
                <strong>{formatEther(outcome.refundWei)} ETH</strong> of your prepayment came back as prepay
                credit.
              </>
            ) : (
              <>Nothing was left of the prepayment to return.</>
            )}
            {creditSentence}
          </p>
        </>
      )}

      {!open && outcome.closedBy !== 'user' && (
        <p style={{ margin: 0 }}>
          {waited} Another account had already closed the round, so your wallet did not need to send a
          transaction. The unspent part of your prepayment came back as prepay credit.
          {creditSentence}
        </p>
      )}

      {open && (
        <>
          <p style={{ margin: '0 0 8px 0' }}>
            {waited} {NOT_SENT_REASONS[outcome.reason] || NOT_SENT_REASONS['send-failed']}
            {txLink}
            {outcome.errorMessage ? <> Details: {outcome.errorMessage}</> : null}
          </p>
          <p style={{ margin: '0 0 8px 0' }}>
            The round is still open on the blockchain. Until it is closed, the unspent part of your prepayment
            stays reserved in it.
          </p>
          <p style={{ margin: '0 0 8px 0' }}>
            To close it, use the button below, or call <code>finalizeEvaluationTimeout</code> with the request
            ID on the aggregator contract{' '}
            <a href={`${explorerUrl}/address/${contractAddress}`} target="_blank" rel="noopener noreferrer">
              <code style={codeStyle}>{contractAddress}</code>
            </a>{' '}
            from any wallet. Anyone can make this call.
          </p>
          <p style={{ margin: '0 0 12px 0' }}>
            Request ID: <code style={codeStyle}>{requestId}</code>
          </p>
          <button
            className="secondary"
            onClick={onCloseRound}
            disabled={closing || disabled}
            style={{ padding: '6px 14px', fontSize: '14px', cursor: closing || disabled ? 'default' : 'pointer' }}
          >
            {closing ? 'Closing the round…' : 'Close the round now'}
          </button>
          {closing && closeStatus ? (
            <span style={{ marginLeft: '10px', color: '#666' }}>{closeStatus}</span>
          ) : null}
        </>
      )}
    </div>
  );
}

export default TimeoutNotice;
