import { useState } from 'react';

import { DisclosureError, disclosureForms, generateDisclosureKeyPair, keyFileName, keyFileText, parseDisclosureKey, saveLocally } from '../lib/disclosure.js';
import { STRINGS, fill } from '../strings.js';
import { TextField } from './Field.jsx';

const K = STRINGS.key;

/**
 * The key in both its forms (node P35): its age recipient, whatever form it was entered in, and the bytes32 list() will
 * store, the form the feed shows. Nothing for a key that does not decode.
 */
function KeyForms({ recipient }) {
  const forms = disclosureForms(recipient);
  if (!forms) return null;
  // each form is one long word: in .mono it may break anywhere, so on a phone it never widens the fieldset
  return <p className="hint" data-testid="key-bytes32">{K.forms} <span className="mono">{fill(STRINGS.disclosure.line, forms)}</span>. {STRINGS.disclosure.note}</p>;
}

/**
 * The maker's disclosure key (design §14). "Generate" makes an age X25519 pair here, with
 * @verdikta/common's disclosure module: the public half goes up to the listing (onRecipient);
 * the private half stays in this component's state only, is shown and offered as a download,
 * and is dropped the moment the maker says it is saved. It is never sent, logged or stored, and
 * nothing can show it again. A maker with an age key already enters its public half instead.
 *
 * @param {{ recipient: string, ready: boolean, onRecipient(recipient: string, ready: boolean): void }} props
 */
export function DisclosureKeyPanel({ recipient, ready, onRecipient }) {
  const [identity, setIdentity] = useState(null);
  const [own, setOwn] = useState(null); // null: not entering one; else the text typed
  const [ownError, setOwnError] = useState(null);

  const generate = () => {
    const pair = generateDisclosureKeyPair();
    setOwn(null);
    setOwnError(null);
    setIdentity(pair.identity);
    onRecipient(pair.recipient, false);
  };

  const saved = () => {
    setIdentity(null);
    onRecipient(recipient, true);
  };

  const typeOwn = (text) => {
    setOwn(text);
    const v = text.trim();
    try {
      parseDisclosureKey(v);
      setOwnError(null);
      onRecipient(v, true);
    } catch (err) {
      // a private key pasted here by mistake is refused like any other text: never listed, never sent
      if (/^AGE-SECRET-KEY-1/i.test(v)) setOwnError(K.ownIsPrivate);
      else setOwnError(v ? fill(K.ownInvalid, { reason: err instanceof DisclosureError ? err.code : 'unreadable' }) : null);
      onRecipient('', false);
    }
  };

  return (
    <div className="key-panel">
      <p className="hint">{K.intro}</p>
      {identity === null && (
        <div className="actions">
          <button type="button" onClick={generate}>{recipient && own === null ? K.replace : K.generate}</button>
          {own === null && (
            <button type="button" className="secondary" onClick={() => { setIdentity(null); onRecipient('', false); setOwn(''); }}>{K.useOwn}</button>
          )}
        </div>
      )}

      {own !== null && <TextField label={K.ownRecipient} value={own} onChange={typeOwn} mono error={ownError} secret={/^AGE-SECRET-KEY-1/i.test(own.trim())} />}

      {own === null && recipient && <TextField label={K.recipient} value={recipient} readOnly mono />}
      {recipient && <KeyForms recipient={recipient} />}

      {identity !== null && (
        <div className="once">
          <TextField label={K.identity} value={identity} readOnly mono secret />
          <p className="warning">{K.shownOnce}</p>
          <div className="actions">
            <button type="button" onClick={() => saveLocally(keyFileName(recipient), keyFileText({ identity, recipient }), 'text/plain')}>{K.download}</button>
            <button type="button" className="secondary" onClick={saved}>{K.saved}</button>
          </div>
        </div>
      )}

      {identity === null && own === null && recipient && ready && <p className="hint">{K.gone}</p>}
    </div>
  );
}
