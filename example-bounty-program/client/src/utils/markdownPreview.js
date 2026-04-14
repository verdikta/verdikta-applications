/**
 * Safe markdown rendering for submission previews.
 *
 * Strips all network-loading media (images, iframes, video, audio, etc.) and
 * replaces each <img> with a visible placeholder showing its URL as a link,
 * so the creator can judge the source before clicking. No image auto-loads.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function replaceImgWithPlaceholder(html) {
  // Match <img ...> tags; extract src and alt attrs (single or double quoted).
  return html.replace(/<img\b([^>]*)>/gi, (_match, attrs) => {
    const srcMatch = /\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const altMatch = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const src = srcMatch ? (srcMatch[2] ?? srcMatch[3] ?? '') : '';
    const alt = altMatch ? (altMatch[2] ?? altMatch[3] ?? '') : '';

    // data: URIs carry the image content inline (no network request). They can
    // still hide SVG-based XSS, so we don't render them either — just show a
    // generic label so the user knows an image was there.
    if (/^data:/i.test(src)) {
      return `<span class="md-image-placeholder">[embedded image${alt ? `: ${escapeHtml(alt)}` : ''} — not rendered]</span>`;
    }

    if (!src) {
      return `<span class="md-image-placeholder">[image — no source]</span>`;
    }

    const safeSrc = escapeHtml(src);
    return (
      `<span class="md-image-placeholder">[image${alt ? `: ${escapeHtml(alt)}` : ''} — ` +
      `<a href="${safeSrc}" target="_blank" rel="noopener noreferrer nofollow">${safeSrc}</a>` +
      `]</span>`
    );
  });
}

export function renderMarkdownSafe(mdText) {
  const raw = marked.parse(mdText || '');
  const transformed = replaceImgWithPlaceholder(raw);
  return DOMPurify.sanitize(transformed, {
    // Belt and braces: even if a rogue <img> survives the regex (e.g. broken HTML
    // that the parser repairs differently), DOMPurify will drop it outright.
    FORBID_TAGS: ['img', 'iframe', 'frame', 'object', 'embed', 'video', 'audio', 'source', 'track', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'background', 'poster', 'formaction', 'srcset'],
    ADD_ATTR: ['target', 'rel'],
  });
}
