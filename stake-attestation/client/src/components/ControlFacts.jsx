import { useId, useState } from 'react';

import { ApiError, sendControlProof } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { CONTROL_FILE_FORMAT, STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const C = STRINGS.control;
const FILE_REASONS = new Set(['NO_PROOF_FILE', 'PROOF_FILE_INVALID', 'PROOF_NAMES_ANOTHER_ADDRESS']);
const RETRY_REASONS = new Set(['REPO_UNAVAILABLE', 'CHAIN_UNAVAILABLE']);

const Mono = ({ children }) => <p className="mono">{children}</p>;

function CheckTimes({ fact }) {
  return (
    <>
      {fact.checkedAt ? <p className="hint">{fill(C.checked, { time: formatTime(fact.checkedAt) })}</p> : null}
      {fact.lastCheckFailed ? <p className="hint">{fill(C.lastCheckFailed, { reason: fact.lastCheckFailed })}</p> : null}
      {fact.nextCheckAt && RETRY_REASONS.has(fact.reason) ? <p className="hint">{fill(C.nextCheck, { time: formatTime(fact.nextCheckAt) })}</p> : null}
    </>
  );
}

/** What the repository line rests on: the commit, the file, the address, and how to re-check it. */
function RepositoryProof({ r, maker }) {
  const onRefs = r.commitOnOwnRefs === true ? fill(C.onRefsYes, { ref: r.ref ?? '' }) : r.commitOnOwnRefs === false ? C.onRefsNo : C.onRefsUnknown;
  return (
    <>
      <p>{onRefs}</p>
      <p className="mono">{r.blob ? fill(C.fileAt, { path: r.path, commit: r.commit, blob: r.blob }) : fill(C.noFile, { path: r.path, commit: r.commit })}</p>
      {r.blob && <p className="mono">{r.fileNames ? fill(C.fileNames, { address: r.fileNames, maker }) : C.fileNamesNothing}</p>}
      {FILE_REASONS.has(r.reason) && <p className="hint">{fill(C.fileHowTo, { path: r.path, format: CONTROL_FILE_FORMAT })}</p>}
      {r.readable && (
        <>
          <p className="hint">{C.recheck}</p>
          <Mono>{fill(C.recheckClone, { repo: r.repo })}</Mono>
          <Mono>{fill(C.recheckRefs, { commit: r.commit })}</Mono>
          <Mono>{fill(C.recheckFile, { commit: r.commit, path: r.path })}</Mono>
        </>
      )}
      <CheckTimes fact={r} />
    </>
  );
}

/** What the deployment line rests on: the signer, its role, the block, and how to re-check it. */
function DeploymentProof({ d }) {
  const yes = d.controls === 'yes';
  const v = { signer: d.signer, signature: d.signature, address: d.address, chainId: d.chainId, block: d.block, tx: d.creationTx };
  return (
    <>
      {d.signer && <p className="mono">{yes ? fill(C.signer, { signer: d.signer, role: C.roles[d.role] ?? d.role }) : fill(C.signer, { signer: d.signer, role: C.no })}</p>}
      {yes && <p className="mono">{fill(C.deploymentAt, v)}</p>}
      {yes && d.contractSigner && <p>{C.contractSigner}</p>}
      {d.creationTx && <p className="mono">{fill(C.creationTx, v)}</p>}
      {d.signature && <p className="mono">{fill(C.signature, v)}</p>}
      {yes && (
        <>
          <TextField label={C.messageSigned} value={d.message} readOnly mono multiline rows={6} />
          <p className="hint">{C.recheckDeployment}</p>
          <Mono>{fill(d.contractSigner ? C.recheckContractSignature : C.recheckSignature, v)}</Mono>
          <Mono>{fill(d.role === 'deployer' ? C.recheckDeployer : C.recheckOwner, v)}</Mono>
        </>
      )}
      <CheckTimes fact={d} />
    </>
  );
}

/**
 * A listing's proof as rows of its stake: "staker named by the repository: yes / no" and, for a
 * contract, "staker controls the deployment: yes / no"; why when "no", and what each rests on, so a
 * reader can check it without this site. A sponsor's wallet can be named, so the repository's line
 * never says "controls".
 */
export function controlRows(c, f) {
  const d = c.deployment;
  const r = c.repository;
  const word = (yes) => (yes ? C.yes : C.no);
  return [
    r ? { id: f('control'), label: C.repository, value: word(r.named === 'yes') } : { id: f('control'), label: C.repository, value: C.no },
    d ? { id: f('control-deployment'), label: C.deployment, value: word(d.controls === 'yes') } : null,
    c.proof === 'yes' ? null : { id: f('control-why'), label: C.why, value: c.detail ?? '' },
    r ? { id: f('control-proof'), label: C.proof, value: <RepositoryProof r={r} maker={c.maker} /> } : null,
    // a deployment with no signature on file rests on nothing yet: its form follows
    d?.signer ? { id: f('control-deployment-proof'), label: C.deploymentProof, value: <DeploymentProof d={d} /> } : null,
  ];
}

/**
 * A contract listing with no standing proof: the message, and the signature sent to the server,
 * from the connected wallet or pasted (a contract owner signs elsewhere). The server checks it on
 * the listing's chain; the signer may be anyone, and only a deployer's or owner's counts.
 */
export function ControlProofForm({ listingId, hash, control, onChanged }) {
  const w = useWalletContext();
  const id = useId();
  const [signer, setSigner] = useState('');
  const [signature, setSignature] = useState('');
  const [creationTx, setCreationTx] = useState('');
  const [busy, setBusy] = useState(null); // signing | sending
  const [error, setError] = useState(null);
  const d = control.deployment;
  if (!d || d.controls === 'yes') return null;

  const sign = async () => {
    setError(null);
    setBusy('signing');
    try {
      const { signer: wallet, account } = await w.ensure();
      setSignature(await wallet.signMessage(d.message));
      setSigner(account);
    } catch (err) {
      setError(fill(C.refused, { reason: walletMessage(err) }));
    } finally {
      setBusy(null);
    }
  };
  const send = async () => {
    setError(null);
    setBusy('sending');
    try {
      await sendControlProof(hash, listingId, { signer: signer.trim(), signature: signature.trim(), creationTx: creationTx.trim() });
      onChanged();
    } catch (err) {
      setError(fill(C.refused, { reason: err instanceof ApiError ? (err.body?.detail ?? err.body?.error ?? err.message) : String(err?.message ?? err) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="report" aria-labelledby={id} data-testid={`control-form-${listingId}`}>
      <h4 id={id}>{C.formTitle}</h4>
      <p className="hint">{C.formIntro}</p>
      <TextField label={C.messageLabel} value={d.message} readOnly mono multiline rows={7} testId="control-message" />
      <TextField label={C.signerField} value={signer} onChange={setSigner} mono testId="control-signer" />
      <TextField label={C.signatureField} value={signature} onChange={setSignature} mono multiline rows={3} testId="control-signature" />
      <TextField label={C.creationTxField} value={creationTx} onChange={setCreationTx} mono testId="control-creation-tx" />
      <p className="actions">
        <button type="button" className="secondary" onClick={sign} disabled={busy !== null}>{busy === 'signing' ? C.signing : C.sign}</button>
        <button type="button" onClick={send} disabled={busy !== null || !signer.trim() || !signature.trim()}>{busy === 'sending' ? C.sending : C.send}</button>
      </p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
