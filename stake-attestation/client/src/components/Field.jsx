import { useId } from 'react';

// Labelled inputs. Every text field turns off spell checking, autocorrection and autofill: a
// browser's enhanced spell check can send what is typed to a remote service, and a key or a
// commit hash is nothing to correct.
const quiet = { spellCheck: false, autoComplete: 'off', autoCorrect: 'off', autoCapitalize: 'off' };

/** `secret`: the field holds the private key; it is marked so test screenshots can mask it. */
export function TextField({ label, value, onChange, error = null, hint = null, multiline = false, rows = 3, mono = false, readOnly = false, inputMode, testId, secret = false }) {
  const id = useId();
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    value,
    readOnly,
    onChange: onChange ? (e) => onChange(e.target.value) : undefined,
    className: mono ? 'mono' : undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': described,
    'data-testid': testId,
    'data-private': secret ? 'true' : undefined,
    // a page translator would send the field's text to its service
    translate: secret ? 'no' : undefined,
    ...quiet,
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline ? <textarea rows={rows} {...common} /> : <input type="text" inputMode={inputMode} {...common} />}
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="field-error" id={`${id}-error`}>{error}</p>}
    </div>
  );
}

export function SelectField({ label, value, onChange, options }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
