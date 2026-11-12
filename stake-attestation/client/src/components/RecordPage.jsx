import { Fragment, useEffect, useId, useState } from 'react';

import { CONFIG } from '../config.js';
import { getRecord } from '../lib/api.js';
import { formatEth, formatTime, formatWhole } from '../lib/format.js';
import { safeguardTerms } from '../lib/claimActions.js';
import { recordView } from '../lib/record.js';
import { STRINGS, fill } from '../strings.js';
import { BadgeEmbed } from './BadgeEmbed.jsx';
import { ControlProofForm, controlRows } from './ControlFacts.jsx';
import { Diligence } from './Diligence.jsx';
import { AsOf, Facts, labelText, siteErrorText } from './Facts.jsx';
import { TextField } from './Field.jsx';
import { ListingWarning } from './ListingWarning.jsx';

const R = STRINGS.record;
const E = STRINGS.enums;
const HASH = /^0x[0-9a-fA-F]{64}$/;

const eth = (wei) => fill(R.eth, { eth: formatEth(wei) });
const when = (t) => (t === null ? R.none : formatTime(t));
// the first of the build's gateways (VITE_IPFS_GATEWAY)
const archiveLink = (cid) => (CONFIG.ipfsGateway
  ? <a className="mono" href={`${CONFIG.ipfsGateway}/ipfs/${cid}`} rel="noreferrer noopener" target="_blank">{cid}</a>
  : <span className="mono">{cid}</span>);

function HashLookup({ initial = '' }) {
  const [hash, setHash] = useState(initial);
  const [bad, setBad] = useState(false);
  const go = () => {
    const h = hash.trim();
    if (!HASH.test(h)) return setBad(true);
    setBad(false);
    window.location.hash = `#/record/${h.toLowerCase()}`;
    return undefined;
  };
  return (
    <div className="lookup">
      <TextField label={R.hash} value={hash} onChange={setHash} mono error={bad ? R.badHash : null} />
      <button type="button" onClick={go}>{R.load}</button>
    </div>
  );
}

function Lineage({ to }) {
  if (!to) return R.none;
  const text = fill(R.lineageLine, { id: to.id, hash: to.hash ?? R.none });
  return to.hash ? <a href={`#/record/${to.hash}`}>{text}</a> : text;
}

/** Each check's name, as the server names it, with how many of the claims name it. */
const checkList = (checks, testId) => (
  <ul className="inline" data-testid={testId}>
    {checks.map(([check, count]) => <li key={check} className="mono">{fill(R.integrityCheckLine, { check, count })}</li>)}
  </ul>
);

/** A listing's floor and size (errata E8, E9), as the record states them; nothing for a record from before them. */
function termRows(l, f) {
  if (l.narrowInvalidFloor === null || l.confirmAboveWei === null) return [];
  const t = safeguardTerms(l);
  return [
    { id: f('narrow-floor'), label: R.narrowFloor, value: t.band.empty ? R.narrowFloorEmpty : fill(R.narrowFloorLine, { floor: formatWhole(t.band.floor), points: t.band.points }) },
    { id: f('confirm-size'), label: R.confirmSize, value: t.size.all ? R.confirmSizeAll : fill(R.confirmSizeLine, { size: formatEth(t.size.wei) }) },
  ];
}

function Stake({ l }) {
  const id = useId();
  const f = (name) => `listing-${l.id}-${name}`;
  return (
    <section className="claim" aria-labelledby={id} data-testid={`listing-${l.id}`}>
      <h4 id={id}>{fill(R.listing, { id: l.id })} <a className="small" href={`#/fund/${l.id}`}>{R.listingPage}</a></h4>
      <Facts rows={[
        { id: f('maker'), label: R.maker, value: <span className="mono">{l.maker}</span> },
        { id: f('state'), label: R.state, value: E.listingStates[l.state] ?? l.state },
        { id: f('labels'), label: R.labels, value: labelText(l.labels) || R.none },
        ...controlRows(l.control, f),
        { id: f('awards'), label: R.awards, value: fill(R.awardsLine, Object.fromEntries(Object.entries(l.awards).map(([c, w]) => [c, formatEth(w)]))) },
        { id: f('lowest'), label: R.lowest, value: l.lowest },
        { id: f('bond'), label: R.bond, value: eth(l.bondWei) },
        ...termRows(l, f),
        { id: f('escrow'), label: R.escrow, value: eth(l.escrowWei) },
        BigInt(l.owedWei) > 0n ? { id: f('owed'), label: R.owed, value: eth(l.owedWei) } : null,
        { id: f('value-at-risk'), label: R.valueAtRisk, value: l.valueAtRiskUsd === null ? R.notDeclared : fill(R.usd, { usd: formatWhole(l.valueAtRiskUsd) }) },
        // node P20: where the listing says its requirements are written
        { id: f('documents'), label: R.documents, value: l.documents === null ? R.documentsUnread : l.documents.length ? <><span className="mono">{l.documents.join(', ')}</span> <span className="hint">{R.documentsNote}</span></> : R.documentsNone },
        l.sharePct !== null ? { id: f('share'), label: R.shareLabel, value: fill(R.share, { usd: formatWhole(l.stakeUsd), share: l.sharePct }) } : null,
        { id: f('listed'), label: R.listedAt, value: when(l.listedAt) },
        { id: f('opened'), label: R.openedAt, value: when(l.openedAt) },
        { id: f('funded-until'), label: R.fundedUntil, value: when(l.fundedUntil) },
        l.rolledAt !== null ? { id: f('rolled'), label: R.rolledAt, value: when(l.rolledAt) } : null,
        l.closedAt !== null ? { id: f('closed'), label: R.closedAt, value: when(l.closedAt) } : null,
        { id: f('days-open'), label: R.daysOpen, value: String(l.daysOpen) },
        { id: f('predecessor'), label: R.predecessor, value: <Lineage to={l.predecessor} /> },
        { id: f('successor'), label: R.successor, value: <Lineage to={l.successor} /> },
        { id: f('integrity'), label: R.integrity, value: l.integrity.failed },
        l.integrity.checks.length > 0 ? { id: f('integrity-checks-row'), label: R.integrityChecks, value: checkList(l.integrity.checks, f('integrity-checks')) } : null,
        { id: f('other-duplicates'), label: R.integrityOther, value: l.integrity.otherDuplicates },
        BigInt(l.integrity.unread) > 0n ? { id: f('integrity-unread'), label: R.integrityUnread, value: l.integrity.unread } : null,
        BigInt(l.integrity.lateFailed) > 0n ? { id: f('integrity-late'), label: R.integrityLate, value: l.integrity.lateFailed } : null,
        l.integrity.lateChecks.length > 0 ? { id: f('integrity-late-checks-row'), label: R.integrityLateChecks, value: checkList(l.integrity.lateChecks, f('integrity-late-checks')) } : null,
      ]} />
      {/* a count beside a maker's address says nothing about the maker, and says so where it is read */}
      {(BigInt(l.integrity.failed) > 0n || BigInt(l.integrity.lateFailed) > 0n) && <p className="hint" data-testid={f('integrity-note')}>{R.integrityNote}</p>}
    </section>
  );
}

/** What the host's API says of the repository, and that a plain copy cannot be told. */
function ForkLabel({ fork }) {
  const F = STRINGS.fork;
  let text = F.unknown;
  if (fork?.status === 'fork') text = fork.parent ? fill(F.yes, { parent: fork.parent }) : F.yesUnknownParent;
  else if (fork?.status === 'not-fork') text = F.no;
  return (
    <>
      <span data-testid="record-fork-status">{text}</span>
      {fork?.note ? <span className="hint" data-testid="record-fork-note"> {fork.note}</span> : null}
    </>
  );
}

/** Any listing of the hash that does not count: apart, with why, and no amount. */
function NotCounted({ apart, hash, onChanged }) {
  const N = STRINGS.notCounted;
  if (!apart.listings.length) return null;
  return (
    <section className="claim" data-testid="record-not-counted">
      <h3>{N.title}</h3>
      <p className="hint">{N.intro}</p>
      {apart.listings.map((l) => (
        <Fragment key={l.id}>
          <Facts
            testId={`not-counted-${l.id}`}
            rows={[
              { id: `not-counted-${l.id}-listing`, label: fill(N.listing, { id: l.id }), value: <a href={`#/fund/${l.id}`}>{R.listingPage}</a> },
              { id: `not-counted-${l.id}-maker`, label: N.maker, value: <span className="mono">{l.maker}</span> },
              { id: `not-counted-${l.id}-state`, label: N.state, value: E.listingStates[l.state] ?? l.state },
              { id: `not-counted-${l.id}-why`, label: N.why, value: l.detail ?? l.reason },
            ]}
          />
          {/* an owner changed, or the listing was built elsewhere: this is where a signature is sent */}
          <ControlProofForm listingId={l.id} hash={hash} control={l.control} onChanged={onChanged} />
        </Fragment>
      ))}
      {apart.findings > 0 && <p data-testid="not-counted-findings">{fill(N.findings, { count: apart.findings })}</p>}
    </section>
  );
}

const verdictList = (verdicts, testId) => (
  <ul className="inline" data-testid={testId}>
    {verdicts.map(([outcome, count]) => <li key={outcome}>{fill(R.verdictLine, { outcome, count })}</li>)}
  </ul>
);

function FindingsTable({ findings, testId, rowId }) {
  return (
    <div className="table-wrap">
      <table data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">{R.findingClaim}</th><th scope="col">{R.findingClass}</th><th scope="col">{R.findingListing}</th>
            <th scope="col">{R.findingHunter}</th><th scope="col">{R.findingPaid}</th><th scope="col">{R.findingOwed}</th>
            <th scope="col">{R.findingRevealed}</th><th scope="col">{R.findingSettled}</th><th scope="col">{R.findingDispute}</th>
            <th scope="col">{R.findingArchive}</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((x) => (
            <tr key={x.claimId} data-testid={`${rowId}-${x.claimId}`}>
              <td>{x.claimId}</td><td>{x.outcome}</td><td>{x.listingId}</td><td className="mono">{x.hunter}</td>
              <td>{eth(x.paidWei)}</td><td>{eth(x.owedWei)}</td><td>{when(x.revealedAt)}</td><td>{when(x.settledAt)}</td>
              <td>{x.disputeKind === 'None' || x.disputeKind === 'Maker' ? (E.disputes[x.dispute] ?? x.dispute) : fill(R.findingRound, { kind: E.disputeKinds[x.disputeKind], result: E.panelResults[x.dispute] ?? x.dispute })}</td><td>{archiveLink(x.bcid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Record({ v, onChanged }) {
  const h = v.history;
  const a = v.artifact;
  return (
    <>
      <AsOf view={v} testId="record-as-of" />
      <section className="claim" data-testid="record-artifact">
        <h3>{R.artifact}</h3>
        <Facts rows={[
          { id: 'record-hash', label: R.artifactHash, value: <span className="mono">{v.hash}</span> },
          { id: 'record-kind', label: R.kind, value: E.kinds[v.kind] ?? v.kind },
          a ? { id: 'record-repo', label: R.repo, value: <span className="mono">{a.repo}</span> } : null,
          a ? { id: 'record-commit', label: R.commit, value: <span className="mono">{a.baseCommit}</span> } : null,
          a && v.kind === 'Contract' ? { id: 'record-address', label: R.address, value: <span className="mono">{a.address}</span> } : null,
          a && v.kind === 'Contract' ? { id: 'record-chain', label: R.chainId, value: a.chainId } : null,
          a ? { id: 'record-fork', label: STRINGS.fork.label, value: <ForkLabel fork={v.fork} /> } : null,
          { id: 'record-listing-count', label: R.listingCount, value: v.listingCount },
          { id: 'record-active', label: R.active, value: v.active.length ? v.active.join(', ') : R.none },
        ]} />
      </section>

      <ListingWarning />
      <h3>{R.stakes}</h3>
      <p className="hint">{STRINGS.control.intro}</p>
      {v.listings.length ? v.listings.map((l) => <Stake key={l.id} l={l} />) : <p data-testid="record-none-counted">{STRINGS.notCounted.none}</p>}
      <NotCounted apart={v.notCounted} hash={v.hash} onChanged={onChanged} />
      {v.placeholders.length > 0 && <p className="hint">{STRINGS.labels.placeholders}</p>}

      <section className="claim" data-testid="record-history">
        <h3>{R.history}</h3>
        <Facts rows={[
          { id: 'history-claims', label: R.claims, value: h.claims },
          { id: 'history-judged', label: R.judged, value: h.judged },
          { id: 'history-pending', label: R.pending, value: h.pending },
          { id: 'history-verdicts-row', label: R.verdicts, value: verdictList(h.verdicts, 'history-verdicts') },
          { id: 'history-integrity', label: R.integrity, value: h.integrityFailed },
          h.integrityChecks.length > 0 ? { id: 'history-integrity-checks-row', label: R.integrityChecks, value: checkList(h.integrityChecks, 'history-integrity-checks') } : null,
          { id: 'history-duplicates', label: R.integrityOther, value: h.duplicates },
          BigInt(h.integrityUnread) > 0n ? { id: 'history-integrity-unread', label: R.integrityUnread, value: h.integrityUnread } : null,
          { id: 'history-released', label: R.released, value: h.released },
          { id: 'history-undisclosed', label: R.undisclosed, value: h.undisclosed },
          { id: 'history-unrevealed', label: R.unrevealed, value: h.unrevealed },
          { id: 'history-no-verdict', label: R.noVerdict, value: h.noVerdict },
          { id: 'history-disputes', label: R.disputes, value: h.disputes.filed },
          { id: 'history-dispute-results', label: R.disputeResults, value: fill(R.disputeLine, h.disputes) },
          // the settlement safeguards (errata E7-E9): the contract's own counts, apart from the maker's disputes
          { id: 'history-appeals', label: R.appeals, value: h.appeals.filed },
          { id: 'history-appeal-results', label: R.appealResults, value: fill(R.appealLine, h.appeals) },
          { id: 'history-confirmations', label: R.confirmations, value: h.confirmations.rounds },
          { id: 'history-confirmation-results', label: R.confirmationResults, value: fill(R.confirmationLine, h.confirmations) },
          { id: 'history-narrow-invalid', label: R.narrowInvalid, value: h.narrowInvalid },
          { id: 'history-days-since', label: R.daysSince, value: h.daysSinceLastValidFinding === null ? R.noValidFinding : String(h.daysSinceLastValidFinding) },
        ]} />
        <p className="hint" data-testid="integrity-note">{R.integrityNote}</p>
        {(BigInt(h.integrityUnread) > 0n || BigInt(v.later.integrityUnread) > 0n) && <p className="hint" data-testid="integrity-unread-note">{R.integrityUnreadNote}</p>}
      </section>

      <section className="claim">
        <h3>{R.findings}</h3>
        {v.findings.length ? <FindingsTable findings={v.findings} testId="record-findings" rowId="finding" /> : <p data-testid="record-findings">{R.noFindings}</p>}
      </section>

      <section className="claim" data-testid="record-later">
        <h3>{R.later}</h3>
        <p className="hint">{R.laterIntro}</p>
        <Facts rows={[
          { id: 'later-claims', label: R.lateClaims, value: v.later.claims },
          { id: 'later-verdicts-row', label: R.lateVerdicts, value: verdictList(v.later.verdicts, 'later-verdicts') },
          BigInt(v.later.integrityFailed) > 0n ? { id: 'later-integrity', label: R.integrityLate, value: v.later.integrityFailed } : null,
          v.later.integrityChecks.length > 0 ? { id: 'later-integrity-checks-row', label: R.integrityLateChecks, value: checkList(v.later.integrityChecks, 'later-integrity-checks') } : null,
          BigInt(v.later.integrityUnread) > 0n ? { id: 'later-integrity-unread', label: R.integrityUnread, value: v.later.integrityUnread } : null,
          { id: 'later-expired', label: R.lateExpired, value: v.later.expired },
          BigInt(v.later.appeals.filed) > 0n ? { id: 'later-appeals', label: R.lateAppeals, value: fill(R.appealLine, v.later.appeals) } : null,
          BigInt(v.later.narrowInvalid) > 0n ? { id: 'later-narrow-invalid', label: R.lateNarrowInvalid, value: v.later.narrowInvalid } : null,
        ]} />
        {v.later.findings.length ? <FindingsTable findings={v.later.findings} testId="record-later-findings" rowId="late-finding" /> : <p>{R.noLaterFindings}</p>}
      </section>

      <section className="claim" data-testid="record-flags">
        <h3>{R.flags}</h3>
        <p className="hint">{R.flagsIntro}</p>
        {v.flags.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th scope="col">{R.flagClaim}</th><th scope="col">{R.flagListing}</th><th scope="col">{R.flagDisclosed}</th><th scope="col">{R.flagState}</th><th scope="col">{R.flagJudged}</th></tr>
              </thead>
              <tbody>
                {v.flags.map((x) => (
                  <tr key={x.claimId} data-testid={`flag-${x.claimId}`}>
                    <td>{x.claimId}{x.late ? ` (${R.flagLate})` : ''}</td><td>{x.listingId}</td><td>{when(x.disclosedAt)}</td>
                    <td>{E.claimStates[x.state] ?? x.state}</td>
                    <td>{x.verdict ? fill(R.judgedLine, { outcome: x.verdict.outcome, time: formatTime(x.verdict.at) }) : R.notJudged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p>{R.noFlags}</p>}
      </section>

      <BadgeEmbed hash={v.hash} />
    </>
  );
}

/**
 * The record of an artifact hash (#/record/<hash>; design §4.1, §13.4), from the site's mirror
 * of recordByHash: facts and the site's labels, then what a record does and does not mean.
 */
export function RecordPage({ hash }) {
  const [loaded, setLoaded] = useState(null); // { view } | { missing } | { failed }
  const [attempt, setAttempt] = useState(0);
  const valid = hash !== null && HASH.test(hash);

  useEffect(() => {
    if (!valid) return undefined;
    let live = true;
    setLoaded(null);
    getRecord(hash.toLowerCase())
      .then((r) => { if (live) setLoaded(r ? { view: recordView(r) } : { missing: true }); })
      .catch((err) => { if (live) setLoaded({ failed: siteErrorText(err) }); });
    return () => { live = false; };
  }, [hash, valid, attempt]);

  const header = (
    <>
      <h2>{R.title}</h2>
      <p className="lead">{R.intro}</p>
    </>
  );
  let body;
  if (hash === null) body = <HashLookup />;
  else if (!valid) body = <><p className="error">{R.badHash}</p><HashLookup initial={hash} /></>;
  else if (!loaded) body = <p className="hint">{R.loading}</p>;
  else if (loaded.missing) body = <><p className="error">{fill(R.notFound, { hash: hash.toLowerCase() })}</p><HashLookup /></>;
  else if (loaded.failed) body = <><p className="error">{loaded.failed}</p><button type="button" onClick={() => setAttempt((x) => x + 1)}>{STRINGS.site.retry}</button></>;
  else body = <Record v={loaded.view} onChanged={() => setAttempt((x) => x + 1)} />;
  return (
    <>
      {header}
      {body}
      <Diligence />
    </>
  );
}
