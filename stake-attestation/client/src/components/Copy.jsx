import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { STRINGS, fill } from '../strings.js';

/**
 * The button beside a long value that copies all of it. It holds an icon and no text, so the
 * element around it still reads as the value alone; its name says what it copies (`what`, the
 * value's label; without one it is a command's).
 */
export function CopyButton({ value, what = null }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // no clipboard here (an old browser, a page not allowed one): the value is on the page to select
    }
  };
  const name = copied ? STRINGS.copy.done : what ? fill(STRINGS.copy.label, { what }) : STRINGS.copy.command;
  return (
    <button type="button" className="copy" aria-label={name} title={name} data-copied={copied ? '' : undefined} onClick={copy}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

/**
 * A hash, an address, an image or a line naming them: all of it, in monospace, wrapping where the
 * line ends, with its copy button. `tone="key"`: the value a page is about.
 */
export function Code({ value, what, tone = null, children = null }) {
  return (
    <span className={tone === 'key' ? 'code-row code-key' : 'code-row'}>
      <span className="mono">{children ?? value}</span>
      <CopyButton value={value} what={what} />
    </span>
  );
}

/**
 * In a table, a long value by its two ends. The value is one piece of text, all of it in the page, so
 * the page's text holds it whole: what a reader selects and copies, what a search of the page finds,
 * and what a tool reads (the local round reads the findings table this way, e2e/src/browser.js). Only
 * the drawing is short: the stylesheet cuts the text off with an ellipsis and draws the value's last
 * characters after it from `data-tail`, which is no part of the page's text. The title shows the whole
 * value on hover. Never split the value between two elements to draw it: a split breaks all three.
 */
export function Short({ value, tail = 6 }) {
  const s = String(value);
  if (s.length <= tail + 12) return <span className="mono">{s}</span>;
  return (
    <span className="short mono" title={s} data-tail={s.slice(-tail)}>
      <span className="short-text">{s}</span>
    </span>
  );
}

/** A command a reader runs to check a fact without this site, with its copy button. */
export function Cmd({ children }) {
  return (
    <div className="cmd">
      <code>{children}</code>
      <CopyButton value={children} />
    </div>
  );
}
