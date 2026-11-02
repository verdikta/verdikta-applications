import { useState } from 'react';

import { ApiError, deploymentMessage } from '../lib/api.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';
import { useWalletContext, walletMessage } from './wallet.js';

const P = STRINGS.listing.proof;
const C = STRINGS.control;

/**
 * A contract listing's signature, sent with the listing request (node P9): the message comes from the
 * server, for the connected wallet as maker and the artifact in the form; the deployer or owner signs
 * it with the connected wallet, or elsewhere and pastes it. The server checks it on the listing's chain.
 */
export function DeploymentProofPanel({ form, proof, onProof }) {
  const w = useWalletContext();
  const [got, setGot] = useState(null); // { key, message }
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const inputs = { repo: form.repo.trim(), baseCommit: form.baseCommit.trim(), chainId: form.chainId.trim(), address: form.address.trim() };
  const key = JSON.stringify(inputs);
  // the owner may be another wallet than the maker: only the artifact in the form makes it stale
  const stale = got && got.key !== key;

  const get = async () => {
    setError(null);
    setBusy('getting');
    try {
      const { account } = await w.ensure();
      const { message } = await deploymentMessage({ maker: account, ...inputs });
      setGot({ key, maker: account, message });
    } catch (err) {
      setError(fill(C.refused, { reason: err instanceof ApiError ? (err.body?.issues?.[0]?.detail ?? err.body?.error ?? err.message) : walletMessage(err) }));
    } finally {
      setBusy(null);
    }
  };
  const sign = async () => {
    setError(null);
    setBusy('signing');
    try {
      const { signer, account } = await w.ensure();
      onProof({ ...proof, signer: account, signature: await signer.signMessage(got.message) });
    } catch (err) {
      setError(fill(C.refused, { reason: walletMessage(err) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="report" data-testid="deployment-proof">
      <h4>{P.title}</h4>
      <p className="hint">{P.intro}</p>
      <p className="actions">
        <button type="button" className="secondary" onClick={get} disabled={busy !== null}>{busy === 'getting' ? P.getting : P.get}</button>
      </p>
      {got && <TextField label={C.messageLabel} value={got.message} readOnly mono multiline rows={7} testId="control-message" />}
      {stale && <p className="error">{P.stale}</p>}
      {got && !stale && (
        <p className="actions">
          <button type="button" className="secondary" onClick={sign} disabled={busy !== null}>{busy === 'signing' ? C.signing : C.sign}</button>
        </p>
      )}
      <TextField label={C.signerField} value={proof.signer} onChange={(v) => onProof({ ...proof, signer: v })} mono testId="control-signer" />
      <TextField label={C.signatureField} value={proof.signature} onChange={(v) => onProof({ ...proof, signature: v })} mono multiline rows={3} testId="control-signature" />
      <TextField label={C.creationTxField} value={proof.creationTx} onChange={(v) => onProof({ ...proof, creationTx: v })} mono testId="control-creation-tx" />
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
