import { useState } from 'react';
import { preview, previewText } from '../../../../skills/verdikta-discover/scripts/preview-core.mjs';
import claims from '../../../../skills/verdikta-discover/examples/source-check-v1.request.json';
import pack from '../../../../skills/verdikta-discover/examples/evidence-pack-v1.request.json';
import review from '../../../../skills/verdikta-discover/examples/review-v1.request.json';
import task from '../../../../skills/verdikta-discover/examples/real-world-task-v1.request.json';
import { workOrderInputKind } from '../utils/buyerPreviewInput.js';
import { pastedJsonText } from '../utils/pastedJson.js';
import { Link } from 'react-router-dom';
import './BuyerPreview.css';

const EXAMPLES = { 'source-check-v1': claims, 'evidence-pack-v1': pack, 'review-v1': review, 'real-world-task-v1': task };

export default function BuyerPreview() {
  const [kind, setKind] = useState('source-check-v1');
  const [text, setText] = useState(JSON.stringify(claims, null, 2));
  const [mode, setMode] = useState('UNSELECTED');
  const [target, setTarget] = useState('');
  const [sharing, setSharing] = useState(false);
  const [local, setLocal] = useState(false);
  const [assessment, setAssessment] = useState(null);
  const [error, setError] = useState('');
  const [importHint, setImportHint] = useState(null);
  function assess(event) {
    event.preventDefault(); setError(''); setAssessment(null); setImportHint(null);
    const json = pastedJsonText(text);
    let request;
    try { request = JSON.parse(json); } catch { setError('Enter a valid JSON request. Nothing has been uploaded.'); return; }
    const inputKind = workOrderInputKind(request);
    if (inputKind) { setImportHint({ kind: inputKind, text: json }); return; }
    try { setAssessment(preview({ template_id: kind, request, sharing_authorized: sharing ? true : undefined, local_sufficient: local, procurement_mode: mode, targetHunter: mode === 'TARGETED' ? target : null })); }
    catch { setError('Enter a valid JSON request. Nothing has been uploaded.'); }
  }
  // The saved file holds exactly the text the skill's script prints for the same input, so both have the same SHA-256.
  function download() {
    const url = URL.createObjectURL(new Blob([previewText(assessment)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `work-order-draft-${assessment.draft.request.task_id}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="agents-section buyer-preview" id="buyer-preview">
    <h2>Need outside help for a bounded task?</h2>
    <p>Preview a work order for up to 20 technical claims, 50 entity-field evidence cells, a 15-question review of a public artifact,
      or a real-world task performed by a person at a place with an evidence pack.
      No wallet, API key, upload or spending is required. This form runs locally in your browser.</p>
    <p>Verdikta provides independently evaluated settlement. Commissioning later requires a real supplier agreement,
      explicit funding authorization and a separate transaction review. Supplier availability, price and delivery time are unknown.</p>
    <p>Have an assessment input from an agent, or a draft saved here? It belongs in the <Link to="/create">Create Bounty</Link> import,
      which derives and checks the draft with the same code. If you paste it below, the preview offers to take it there.</p>
    <form onSubmit={assess}>
      <label>Service template <select value={kind} onChange={e => {
        setKind(e.target.value); setText(JSON.stringify(EXAMPLES[e.target.value], null, 2)); setAssessment(null);
      }}>
        <option value="source-check-v1">Technical Claim Source Check</option>
        <option value="evidence-pack-v1">Bounded Evidence Pack</option>
        <option value="review-v1">Review of a Public Artifact</option>
        <option value="real-world-task-v1">Real-World Task with an Evidence Pack</option>
      </select></label>
      <label>Supplier selection <select value={mode} onChange={e => { setMode(e.target.value); setAssessment(null); }}>
        <option value="UNSELECTED">Choose participation</option>
        <option value="TARGETED">Target a known supplier</option>
        <option value="OPEN">Intentionally open to submissions</option>
      </select></label>
      {mode === 'TARGETED' && <label>Known supplier wallet address
        <input type="text" value={target} onChange={e => { setTarget(e.target.value); setAssessment(null); }} placeholder="0x…" />
      </label>}
      <p>The prefilled request is synthetic and cannot be commissioned. Replace it with your bounded request. A documented unresolved answer is valid; fabricated evidence is not.</p>
      <label>Request JSON
        <textarea rows={14} value={text} onChange={e => { setText(e.target.value); setAssessment(null); setImportHint(null); }} spellCheck={false} />
      </label>
      <label><input type="checkbox" checked={sharing} onChange={e => { setSharing(e.target.checked); setAssessment(null); }} /> Inputs are public, non-sensitive and approved for external sharing. This grants no spending authority.</label>
      <label><input type="checkbox" checked={local} onChange={e => { setLocal(e.target.checked); setAssessment(null); }} /> My available local tools and sources already meet the need.</label>
      <button type="submit" className="btn btn-primary">Preview a work order</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {importHint && <p role="alert">
      This is {importHint.kind === 'draft' ? 'a saved work-order draft' : 'an assessment input from an agent'}, not a request.
      Open it on the <Link to="/create" state={{ workOrderPaste: importHint.text }}>Create Bounty</Link> page: it goes into
      "Import a work-order draft" there, which checks it with the same code and shows its draft SHA-256. Nothing has been uploaded.
    </p>}
    {assessment && <div aria-live="polite">
      <h3>{{PREVIEW: 'Draft ready for review', HANDOFF_REQUESTED: 'Ready for a separate funding review', NEEDS_SCOPE: 'More information needed', LOCAL: 'Handle this task locally', UNSUITABLE: 'Not suitable for external work'}[assessment.decision]}</h3>
      <p>Draft only — no quote or spending authorization.</p>
      <p>{assessment.reason}</p>
      <p>Procurement: {assessment.procurement.mode}{assessment.procurement.targetHunter ? ` — ${assessment.procurement.targetHunter}` : ''}</p>
      <p>Supplier: UNKNOWN · Price: UNKNOWN · Availability: UNKNOWN. No live quote or funding authorization exists.</p>
      {assessment.inputs_needed.length > 0 && <ul>{assessment.inputs_needed.map((s, i) => <li key={i}>{s}</li>)}</ul>}
      <p>{assessment.next_action}</p>
      <details><summary>Deliverable, criteria and commissioning requirements</summary><pre>{JSON.stringify(assessment, null, 2)}</pre></details>
      {assessment.draft && <button type="button" onClick={download}>Save draft locally</button>}
    </div>}
  </section>;
}
