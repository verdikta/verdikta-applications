// The production build carries /agents.txt and /llms.txt (node P27): Vite copies public/ to the build's root, and the
// deploy kit serves the build's root as the site's (deploy/nginx, `root`). This builds the client into a folder of its
// own, as `npm run build` does with vite.config.js, and reads both files there, byte for byte.
//
// The page itself points at them too (node P29). A fetch of / that runs no JavaScript gets the shell, index.html, and
// many agents' fetch tools turn it into text, dropping <head>, <noscript> or both. So the shell names the documents in
// three places: in <head> (an alternate link to each, and a description that names /agents.txt), in a short paragraph
// inside #root, which React replaces when it mounts, and in a <noscript> with the same links. All of it is static
// markup that the deploy kit's Content-Security-Policy allows as it is: no inline script and no style attribute.
// The checks run on client/index.html and on the build's index.html, the file nginx serves at /.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

import { wordingProblems } from '../e2e/support/wording.js';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(CLIENT, 'public');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-client-build-'));
after(() => fs.rmSync(outDir, { recursive: true, force: true }));
before(async () => {
  await build({ root: CLIENT, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
});

const GUIDE = '/agents.txt';
const INDEX = '/llms.txt';
/** The fallback's id: e2e/smoke.spec.js finds it in the page as served and checks that it is gone once the app mounts. */
const FALLBACK_ID = 'agents-fallback';

/** The attributes in one start tag's text, by lower-case name. */
const attrsOf = (s) =>
  new Map([...s.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']));
/** Every start tag `name` in `html`, with its attributes. */
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((m) => ({ raw: m[0], attrs: attrsOf(m[1]) }));
/** What is inside the first `<name>` element (one that never nests in itself). */
const inside = (html, name) => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(html)?.[1];
/** The div with this id: what is inside it (its own nested divs counted), and the text around it. */
function divById(html, id) {
  const open = new RegExp(`<div\\b[^>]*\\sid="${id}"[^>]*>`, 'i').exec(html);
  assert.ok(open, `a <div id="${id}">`);
  const start = open.index + open[0].length;
  const tokens = /<div\b[^>]*>|<\/div\s*>/gi;
  tokens.lastIndex = start;
  for (let depth = 1, m; (m = tokens.exec(html));) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return { content: html.slice(start, m.index), around: html.slice(0, open.index) + html.slice(m.index + m[0].length) };
  }
  assert.fail(`<div id="${id}"> is closed`);
}
const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, '\'')
  .replace(/&amp;/g, '&');
const stripTags = (html) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const dropNoscript = (html) => html.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ');
/** The text that a fetch tool which runs no JavaScript, and drops <head> and every <noscript>, shows of a page. */
const textWithoutHeadOrNoscript = (html) => stripTags(dropNoscript(html.replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')));
/** The site paths a text names (/agents.txt, /llms.txt ...): a slash, then a file name with an extension. */
const pathsNamed = (text) => [...text.matchAll(/(?<![\w./:-])\/[\w-]+(?:\.[\w-]+)+(?![\w/-])/g)].map((m) => m[0]);
const inPublic = (p) => fs.existsSync(path.join(PUBLIC, p)) && fs.statSync(path.join(PUBLIC, p)).isFile();
const descriptionOf = (head) => decode(tags(head, 'meta').find((t) => t.attrs.get('name') === 'description')?.attrs.get('content') ?? '');

const builtShell = () => fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
const shells = () => [['client/index.html', fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8')], ['the build\'s index.html', builtShell()]];

test('vite build puts agents.txt and llms.txt at the root of the build, as they are in public/', () => {
  assert.ok(fs.existsSync(path.join(outDir, 'index.html')), 'the build ran');
  for (const name of ['agents.txt', 'llms.txt']) {
    const built = path.join(outDir, name);
    assert.ok(fs.existsSync(built), `${name} is in the build`);
    assert.ok(fs.readFileSync(built).equals(fs.readFileSync(path.join(CLIENT, 'public', name))), `${name} is the public file, byte for byte`);
  }
});

test('the shell\'s <head> links both documents as alternates, and its description names /agents.txt', () => {
  for (const [label, html] of shells()) {
    const head = inside(html, 'head');
    assert.ok(head, `${label}: a <head>`);
    const alternates = tags(head, 'link').filter((t) => t.attrs.get('rel') === 'alternate');
    const guide = alternates.filter((t) => t.attrs.get('href') === GUIDE);
    assert.equal(guide.length, 1, `${label}: one <link rel="alternate" href="${GUIDE}">`);
    assert.equal(guide[0].attrs.get('type'), 'text/plain', `${label}: the guide's link says text/plain`);
    assert.equal(guide[0].attrs.get('title'), 'Instructions for agents', `${label}: the guide's link title`);
    const index = alternates.filter((t) => t.attrs.get('href') === INDEX);
    assert.equal(index.length, 1, `${label}: one <link rel="alternate" href="${INDEX}">`);
    assert.equal(index[0].attrs.get('type'), 'text/plain', `${label}: the index's link says text/plain`);
    assert.match(index[0].attrs.get('title') ?? '', /\bagents\b/i, `${label}: the index's link has a title for agents`);

    assert.equal(tags(head, 'meta').filter((t) => t.attrs.get('name') === 'description').length, 1, `${label}: one <meta name="description">`);
    const description = descriptionOf(head);
    assert.ok(description.includes(GUIDE), `${label}: the description names ${GUIDE}: ${description}`);
    assert.match(description, /^Verdikta stake attestation\b/, `${label}: the description says what the site is`);
    // one sentence, and nothing that belongs to a listing: no number at all, so no amount, address, hash or window
    assert.match(description, /\.$/, `${label}: the description is a sentence`);
    assert.doesNotMatch(description.slice(0, -1), /[.!?](?=\s|$)/, `${label}: the description is one sentence`);
    assert.doesNotMatch(description, /\d/, `${label}: no number in the description`);
    assert.deepEqual(wordingProblems(description), [], `${label}: the description's wording`);
  }
});

test('the shell\'s body names both documents in text inside #root, which a fetch that drops <head> and <noscript> keeps', () => {
  for (const [label, html] of shells()) {
    const body = inside(html, 'body');
    assert.ok(body, `${label}: a <body>`);
    const root = divById(body, 'root');
    // everything the body says is inside #root, so the app's first render replaces all of it (src/main.jsx)
    assert.equal(stripTags(root.around), '', `${label}: no text in <body> outside #root`);
    const fallback = divById(root.content, FALLBACK_ID);
    assert.equal(stripTags(fallback.around), '', `${label}: #root holds the fallback and nothing else`);

    const text = textWithoutHeadOrNoscript(html);
    for (const p of [GUIDE, INDEX]) assert.ok(text.includes(p), `${label}: the text without <head> and <noscript> names ${p}: ${text}`);
    assert.match(text, /\bagents\b/i, `${label}: the text says who the documents are for`);
    assert.equal(textWithoutHeadOrNoscript(fallback.content), text, `${label}: all of that text is the fallback's`);
    const links = tags(dropNoscript(fallback.content), 'a').map((t) => t.attrs.get('href'));
    assert.deepEqual(links.toSorted(), [GUIDE, INDEX].toSorted(), `${label}: the fallback links both documents, outside <noscript>`);
    assert.deepEqual(wordingProblems(text), [], `${label}: the fallback's wording`);
    assert.doesNotMatch(text, /\d/, `${label}: no number in the fallback, so nothing that belongs to a listing`);

    assert.equal((html.match(/<noscript\b/gi) ?? []).length, 1, `${label}: one <noscript>`);
    const noscript = /<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/i.exec(fallback.content)?.[1];
    assert.ok(noscript !== undefined, `${label}: the <noscript> is in the fallback`);
    assert.deepEqual(tags(noscript, 'a').map((t) => t.attrs.get('href')).toSorted(), [GUIDE, INDEX].toSorted(), `${label}: the <noscript> links both documents`);
    for (const p of [GUIDE, INDEX]) assert.ok(stripTags(noscript).includes(p), `${label}: the <noscript>'s text names ${p}`);
    assert.deepEqual(wordingProblems(stripTags(noscript)), [], `${label}: the <noscript>'s wording`);
    assert.doesNotMatch(stripTags(noscript), /\d/, `${label}: no number in the <noscript>`);
  }
});

test('every document path the shell names is a file in client/public, and the shell names both of them', () => {
  for (const [label, html] of shells()) {
    const head = inside(html, 'head');
    const hrefs = [
      ...tags(head, 'link').filter((t) => t.attrs.get('rel') === 'alternate').map((t) => t.attrs.get('href')),
      ...tags(html, 'a').map((t) => t.attrs.get('href')),
    ];
    const named = [...hrefs, ...pathsNamed(descriptionOf(head)), ...pathsNamed(stripTags(html.replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ')))];
    for (const p of named) {
      assert.match(p, /^\/[^/]/, `${label}: ${p} is a path on the site, not a URL`);
      assert.ok(inPublic(p), `${label}: ${p} is a file in client/public`);
    }
    for (const p of [GUIDE, INDEX]) {
      assert.ok(inPublic(p), `${p} is in client/public`);
      assert.equal(hrefs.filter((h) => h === p).length, 3, `${label}: ${p} is linked from <head>, the fallback and the <noscript>`);
    }
  }
});

test('the shell is static markup the deploy kit\'s policy allows as it is: no inline script, no style, no handler', () => {
  const classes = new Set([...fs.readFileSync(path.join(CLIENT, 'src', 'styles.css'), 'utf8').matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  for (const [label, html] of shells()) {
    for (const s of tags(html, 'script')) assert.ok(s.attrs.has('src'), `${label}: every <script> loads a file: ${s.raw}`);
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) assert.equal(m[1].trim(), '', `${label}: no inline script`);
    assert.doesNotMatch(html, /<style\b/i, `${label}: no <style> element`);
    for (const m of html.matchAll(/<[a-z][^>]*>/gi)) {
      const attrs = attrsOf(m[0].slice(1, -1).replace(/^[a-z][\w-]*/i, ''));
      assert.ok(!attrs.has('style'), `${label}: no style attribute: ${m[0]}`);
      for (const name of attrs.keys()) assert.doesNotMatch(name, /^on/, `${label}: no event handler attribute: ${m[0]}`);
      for (const value of attrs.values()) assert.doesNotMatch(value, /^\s*javascript:/i, `${label}: no javascript: URL: ${m[0]}`);
      for (const c of (attrs.get('class') ?? '').split(/\s+/).filter(Boolean)) assert.ok(classes.has(c), `${label}: class ${c} is one of src/styles.css`);
    }
  }
});

test('the app mounts on #root with createRoot, whose first render replaces what the shell put there, and hydrates nothing', () => {
  const main = fs.readFileSync(path.join(CLIENT, 'src', 'main.jsx'), 'utf8');
  assert.match(main, /createRoot\(document\.getElementById\('root'\)\)\.render\(/);
  assert.doesNotMatch(main, /hydrateRoot/);
});

test('what a fetch of / that runs no JavaScript and drops <head> and <noscript> shows of the build\'s index.html', (t) => {
  const text = textWithoutHeadOrNoscript(builtShell());
  t.diagnostic(`stripped: ${text}`);
  for (const p of [GUIDE, INDEX]) assert.ok(text.includes(p), p);
});
