/**
 * Register-an-arbiter section for My Arbiters.
 *
 * A standalone form (collapsible) to register an (oracle, jobId) from scratch —
 * for bringing up a new arbiter, recovering one from a downloaded JSON backup,
 * or re-registering after a manual close-out. Fields can be typed or filled by
 * importing an arbiter descriptor JSON (see utils/arbiterRegistration). On
 * submit it hands fixed params to RegisterArbiterModal, which runs the
 * approve → register transactions.
 */

import { useRef, useState } from 'react';
import { PlusCircle, Upload, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import RegisterArbiterModal from './RegisterArbiterModal';
import {
  parseClasses,
  parseFee,
  isValidAddress,
  isValidJobId,
  parseDescriptor,
} from '../utils/arbiterRegistration';

function RegisterArbiterSection({
  keeperAddress,
  network,
  owner,
  chain,
  onCorrectChain,
  getSigner,
  toast,
  onComplete,
}) {
  const [open, setOpen] = useState(false);
  const [operator, setOperator] = useState('');
  const [jobId, setJobId] = useState('');
  const [fee, setFee] = useState('');
  const [classes, setClasses] = useState('');
  const [importNote, setImportNote] = useState(null); // { kind: 'warn'|'ok', text }
  const [modalParams, setModalParams] = useState(null);
  const fileRef = useRef(null);

  // --- Validation ---------------------------------------------------------
  const operatorValid = isValidAddress(operator);
  const jobIdValid = isValidJobId(jobId.trim());
  const feeP = parseFee(fee);
  const classP = parseClasses(classes);
  const formValid = operatorValid && jobIdValid && !feeP.error && !classP.error;

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const text = await file.text();
        const d = parseDescriptor(text);
        setOperator(d.operator);
        setJobId(d.jobId);
        setFee(d.fee);
        setClasses(d.classes.join(', '));
        if (d.network && d.network !== network) {
          setImportNote({
            kind: 'warn',
            text: `This descriptor is for network "${d.network}", but you are on "${network}". It will be registered on "${network}".`,
          });
        } else {
          setImportNote({ kind: 'ok', text: `Imported "${file.name}". Review the fields, then register.` });
        }
      } catch (err) {
        setImportNote({ kind: 'warn', text: err.message || 'Could not import that file.' });
      }
    }
    // Allow re-importing the same file name.
    e.target.value = '';
  };

  const startRegister = () => {
    setModalParams({
      operator: operator.trim(),
      jobId: jobId.trim(),
      fee: feeP.display,
      classes: classP.classes,
    });
  };

  return (
    <section className="analytics-section register-section">
      <button className="register-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        <PlusCircle size={18} className="inline-icon" />
        <h2>Register an arbiter</h2>
        <span className="register-toggle-hint">
          New arbiter, or recover/re-register from a backup JSON
        </span>
      </button>

      {open && (
        <div className="register-body">
          <p className="register-intro">
            Register an arbiter (oracle + Job&nbsp;ID) on {chain.name}. The connected wallet must own
            the operator contract. Fill the fields or import a previously downloaded backup. This
            stakes 100&nbsp;wVDKA.
          </p>

          <div className="register-import">
            <button className="btn btn-secondary btn-with-icon" onClick={() => fileRef.current?.click()}>
              <Upload size={14} /> Import JSON
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImport}
              style={{ display: 'none' }}
            />
            {importNote && (
              <span className={`register-import-note ${importNote.kind}`}>
                {importNote.kind === 'warn' && <AlertTriangle size={13} />} {importNote.text}
              </span>
            )}
          </div>

          <div className="register-fields">
            <label className="reset-field">
              <span>Operator (oracle) address</span>
              <input
                type="text"
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                placeholder="0x…"
                aria-invalid={operator !== '' && !operatorValid}
              />
            </label>
            <label className="reset-field">
              <span>Job ID (0x + 64 hex)</span>
              <input
                type="text"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                placeholder="0x…"
                aria-invalid={jobId !== '' && !jobIdValid}
              />
            </label>
            <label className="reset-field">
              <span>Fee (ETH)</span>
              <input
                type="number" min="0" step="0.00001"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                placeholder="0.0001"
                aria-invalid={fee !== '' && !!feeP.error}
              />
            </label>
            <label className="reset-field">
              <span>Classes (1–5, comma-separated)</span>
              <input
                type="text"
                value={classes}
                onChange={(e) => setClasses(e.target.value)}
                placeholder="e.g. 128, 129"
                aria-invalid={classes !== '' && !!classP.error}
              />
            </label>
          </div>

          {operator !== '' && !operatorValid && <div className="reset-edit-error">Invalid operator address.</div>}
          {jobId !== '' && !jobIdValid && <div className="reset-edit-error">Job ID must be 0x followed by 64 hex chars.</div>}
          {fee !== '' && feeP.error && <div className="reset-edit-error">{feeP.error}</div>}
          {classes !== '' && classP.error && <div className="reset-edit-error">{classP.error}</div>}

          <div className="register-actions">
            <button
              className="btn btn-primary btn-with-icon"
              onClick={startRegister}
              disabled={!formValid || !onCorrectChain}
              title={!onCorrectChain ? `Switch to ${chain.name} to register` : undefined}
            >
              <PlusCircle size={14} /> Register arbiter
            </button>
            {!onCorrectChain && (
              <span className="register-chain-hint">Switch to {chain.name} to register.</span>
            )}
          </div>
        </div>
      )}

      {modalParams && (
        <RegisterArbiterModal
          operator={modalParams.operator}
          jobId={modalParams.jobId}
          fee={modalParams.fee}
          classes={modalParams.classes}
          keeperAddress={keeperAddress}
          owner={owner}
          chain={chain}
          getSigner={getSigner}
          toast={toast}
          onClose={() => setModalParams(null)}
          onComplete={() => { setModalParams(null); onComplete?.(); }}
        />
      )}
    </section>
  );
}

export default RegisterArbiterSection;
