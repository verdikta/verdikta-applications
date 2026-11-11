import { MAX_DOCUMENTS } from '../lib/documents.js';
import { SEVERITY_CLASSES, setKind, setWindow } from '../lib/draft.js';
import { knownIssueEntry } from '../lib/knownIssues.js';
import { CONTROL_FILE_FORMAT, STRINGS, fill } from '../strings.js';
import { SelectField, TextField } from './Field.jsx';

const L = STRINGS.listing;
const F = L.fields;
const classOptions = SEVERITY_CLASSES.map((c) => ({ value: c, label: c }));
let rowKeys = 0;

/** The label of a form field, for the "complete these first" line. */
export function fieldLabel(key) {
  if (key.startsWith('awards.')) return fill(F.award, { class: key.slice('awards.'.length) });
  return F[key] ?? key;
}

/** Each line of the documents field common would refuse, by common's code (lib/documents.js). */
function documentsText(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  return issues.map((i) => (i.index === null
    ? fill(L.documentCodes.tooMany, { max: MAX_DOCUMENTS })
    : fill(L.documentIssue, { line: i.index + 1, entry: JSON.stringify(i.entry), code: i.code, text: L.documentCodes[i.code] }))).join(' ');
}

/** The message under a field: the window bounds always, an amount only once something is typed. */
function issueText(issues, key, value) {
  const code = issues[key];
  if (!code) return null;
  if (code === 'amount' && String(value).trim() === '') return null;
  return L.bounds[code];
}

function KnownIssuesEditor({ rows, onChange }) {
  const K = L.knownIssues;
  const update = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      {rows.length === 0 && <p className="hint">{K.none}</p>}
      {rows.map((row, i) => {
        const complete = row.title.trim() && row.paths.trim() && row.description.trim();
        return (
          <fieldset key={row.key} className="known-issue">
            <legend>{fill(K.legend, { n: i + 1 })}</legend>
            <TextField label={K.title} value={row.title} onChange={(v) => update(i, { title: v })} />
            <SelectField label={K.class} value={row.class} onChange={(v) => update(i, { class: v })} options={classOptions} />
            <TextField label={K.paths} value={row.paths} onChange={(v) => update(i, { paths: v })} multiline rows={2} mono />
            <TextField label={K.description} value={row.description} onChange={(v) => update(i, { description: v })} multiline rows={3} />
            {complete && <p className="hint mono">{fill(K.id, { id: knownIssueEntry(row).id })}</p>}
            <button type="button" className="secondary" onClick={() => onChange(rows.filter((_, j) => j !== i))}>{K.remove}</button>
          </fieldset>
        );
      })}
      <button type="button" className="secondary" onClick={() => onChange([...rows, { key: (rowKeys += 1), title: '', class: 'LOW', paths: '', description: '' }])}>{K.add}</button>
    </>
  );
}

/**
 * The listing terms. `setForm` takes an updater. The disclosure key is a section of its own,
 * passed in as `keyPanel`, so the private half never enters the form's state.
 */
export function ListingForm({ form, setForm, issues, keyPanel, proofPanel = null }) {
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const win = (k) => (v) => setForm((f) => setWindow(f, k, v));
  const cmd = (k) => (v) => setForm((f) => ({ ...f, commands: { ...f.commands, [k]: v } }));
  const award = (c) => (v) => setForm((f) => ({ ...f, awards: { ...f.awards, [c]: v } }));

  return (
    <>
      <fieldset>
        <legend>{L.sections.artifact}</legend>
        <p className="hint">{fill(L.hints.control, { format: CONTROL_FILE_FORMAT })}</p>
        <SelectField
          label={F.kind}
          value={form.kind}
          onChange={(v) => setForm((f) => setKind(f, v))}
          options={[{ value: 'repo', label: F.kindRepo }, { value: 'contract', label: F.kindContract }]}
        />
        <TextField label={F.repo} value={form.repo} onChange={set('repo')} mono />
        <TextField label={F.baseCommit} value={form.baseCommit} onChange={set('baseCommit')} mono />
        {form.kind === 'contract' && (
          <>
            <TextField label={F.address} value={form.address} onChange={set('address')} mono />
            <TextField label={F.chainId} value={form.chainId} onChange={set('chainId')} inputMode="numeric" />
            {proofPanel}
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>{L.sections.scope}</legend>
        <TextField label={F.scopeInclude} value={form.scopeInclude} onChange={set('scopeInclude')} multiline rows={2} mono />
        <TextField label={F.scopeExclude} value={form.scopeExclude} onChange={set('scopeExclude')} multiline rows={2} mono />
      </fieldset>

      <fieldset>
        <legend>{L.sections.documents}</legend>
        <TextField label={F.documents} value={form.documents} onChange={set('documents')} multiline rows={3} mono hint={L.hints.documents} error={documentsText(issues.documents)} />
      </fieldset>

      <fieldset>
        <legend>{L.sections.awards}</legend>
        <p className="hint">{L.hints.awards}</p>
        <div className="grid4">
          {SEVERITY_CLASSES.map((c) => (
            <TextField key={c} label={fill(F.award, { class: c })} value={form.awards[c]} onChange={award(c)} inputMode="decimal" error={issueText(issues, `awards.${c}`, form.awards[c])} />
          ))}
        </div>
        <SelectField label={F.lowestClassCounted} value={form.lowestClassCounted} onChange={set('lowestClassCounted')} options={classOptions} />
      </fieldset>

      <fieldset>
        <legend>{L.sections.bond}</legend>
        <TextField label={F.bond} value={form.bond} onChange={set('bond')} inputMode="decimal" hint={L.hints.bond} error={issueText(issues, 'bond', form.bond)} />
      </fieldset>

      <fieldset>
        <legend>{L.sections.windows}</legend>
        <p className="hint">{L.hints.windows}</p>
        <div className="grid4">
          {['fixWindowDays', 'disputeWindowHours', 'disclosureGraceHours', 'revealWindowDays'].map((k) => (
            <TextField key={k} label={F[k]} value={form[k]} onChange={win(k)} inputMode="numeric" error={issueText(issues, k, form[k])} />
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>{L.sections.allowlist}</legend>
        <TextField label={F.allowlist} value={form.allowlist} onChange={set('allowlist')} multiline rows={3} mono hint={L.hints.allowlist} />
      </fieldset>

      <fieldset>
        <legend>{L.sections.knownIssues}</legend>
        <p className="hint">{L.hints.knownIssues}</p>
        <p className="hint">{L.hints.knownIssuesIntended}</p>
        <KnownIssuesEditor rows={form.knownIssues} onChange={set('knownIssues')} />
      </fieldset>

      <fieldset>
        <legend>{L.sections.valueAtRisk}</legend>
        <TextField label={F.valueAtRiskUsd} value={form.valueAtRiskUsd} onChange={set('valueAtRiskUsd')} inputMode="numeric" hint={L.hints.valueAtRisk} error={issueText(issues, 'valueAtRiskUsd', form.valueAtRiskUsd)} />
      </fieldset>

      <details>
        <summary>{L.sections.environment}</summary>
        {['setup', 'build', 'test', 'testFiles', 'testIds', 'lint'].map((k) => (
          <TextField key={k} label={F[k]} value={form.commands[k]} onChange={cmd(k)} mono />
        ))}
        <TextField label={F.testPaths} value={form.testPaths} onChange={set('testPaths')} multiline rows={2} mono />
        <TextField label={F.protectedPaths} value={form.protectedPaths} onChange={set('protectedPaths')} multiline rows={3} mono />
      </details>

      <fieldset>
        <legend>{L.sections.disclosure}</legend>
        {keyPanel}
      </fieldset>
    </>
  );
}
