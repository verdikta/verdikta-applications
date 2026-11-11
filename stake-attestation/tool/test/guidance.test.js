// Node P19, the owner's decisions of 2026-11-10 as a hunter reads them (Q73 #2 and #4):
// - report.md's "## Requirement" section: where the code is required to behave as the PoC asserts, a file and
//   line or a listing document, and, where nothing states it, the hunter says so; in the help and the README's
//   hunter section, and check warns, never refuses, when report.md has none;
// - the consequence sentence, word for word, in the help, the pre-commit notice and the README's hunter section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CONSEQUENCE, REQUIREMENT, USAGE, commitNotice } from '../src/index.js';
import { requirementWarnings } from '../src/report.js';
import { REPORT } from './helpers/world.js';

const DECIDED = 'Make the PoC demonstrate the consequence you claim; the jury classes by what it shows.';
const README = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

/** One "## " section of the README, heading to the next. */
function section(heading) {
  const start = README.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, heading);
  const end = README.indexOf('\n## ', start + 1);
  return README.slice(start, end < 0 ? undefined : end);
}
const HUNTER = section('The hunter tool');
const flat = (text) => text.replace(/\s+/g, ' ');

const TERMS = { listingId: 7n, bondWei: 1n, priceWei: 2n, feeWei: 1n, awards: [0n, 1n, 2n, 3n], lowestClass: 'MEDIUM', invited: false, fixWindow: 0n, revealWindow: 1n, disputeWindow: 1n, repo: 'https://example.invalid/r', baseCommit: 'a'.repeat(40) };
const codes = (text) => requirementWarnings(Buffer.from(text, 'utf8')).map((w) => w.code);

test('the consequence sentence is the decided one, word for word, in the help, the pre-commit notice and the README', () => {
  assert.equal(CONSEQUENCE, DECIDED);
  assert.ok(USAGE.includes(DECIDED), 'help');
  assert.ok(commitNotice(TERMS).includes(DECIDED), 'the notice commit prints before it pays');
  assert.ok(HUNTER.includes(DECIDED), 'README, "The hunter tool"');
});

test('the help and the README describe report.md\'s "## Requirement" section, and where nothing states it, the hunter says so', () => {
  for (const [where, text] of [['help', USAGE], ['README', flat(HUNTER)], ['the text itself', REQUIREMENT]]) {
    assert.ok(text.includes('## Requirement'), where);
    assert.match(text, /where the code is required to behave as (the|your) PoC asserts/, where);
    assert.match(text, /a file and line, or a listing document/, where);
    assert.match(text, /If nothing in the code or the listing states it, say so/, where);
  }
  // the help and the README say that check warns, and refuses nothing, without the section
  assert.match(USAGE, /check warns, and refuses nothing,/);
  assert.match(flat(HUNTER), /warns, and refuses nothing, when `?report\.md`? has no `?## Requirement`? section/);
});

test('the warning names the missing section and says what goes in it', () => {
  const [w] = requirementWarnings(Buffer.from(REPORT));
  assert.equal(w.code, 'NO_REQUIREMENT_SECTION');
  assert.ok(w.detail.includes('## Requirement'));
  assert.ok(w.detail.includes(REQUIREMENT), 'what goes in it');
  assert.match(w.detail, /refuses nothing/);
});

test('the heading is an ATX heading of any depth and case, Requirement or Requirements, read outside code fences', () => {
  const body = 'src/Vault.sol:42: the NatSpec says withdraw pays the caller\'s balance only.';
  for (const heading of ['## Requirement', '# Requirement', '###### Requirement', '## requirement', '## REQUIREMENTS', '   ## Requirement', '## Requirement ##', '## Requirement: src/Vault.sol:42', '##\tRequirement']) {
    assert.deepEqual(codes(`# Title\n\n${heading}\n\n${body}\n`), [], heading);
  }
  for (const heading of ['####### Requirement', '##Requirement', '    ## Requirement', '## Requirementless', '## The requirement', '**Requirement**', 'Requirement:']) {
    assert.deepEqual(codes(`# Title\n\n${heading}\n\n${body}\n`), ['NO_REQUIREMENT_SECTION'], heading);
  }
  // a setext heading is not read, and neither is a heading inside a fenced block
  assert.deepEqual(codes(`# Title\n\nRequirement\n-----------\n\n${body}\n`), ['NO_REQUIREMENT_SECTION']);
  assert.deepEqual(codes(`# Title\n\n\`\`\`md\n## Requirement\n${body}\n\`\`\`\n`), ['NO_REQUIREMENT_SECTION']);
  assert.deepEqual(codes(`# Title\n\n~~~~\n## Requirement\n~~~\n${body}\n~~~~\n`), ['NO_REQUIREMENT_SECTION']);
  assert.deepEqual(codes(`# Title\n\n\`\`\`\ncode\n\`\`\`\n\n## Requirement\n\n${body}\n`), [], 'after a closed fence');
});

test('a section with nothing under its heading is warned of too; a subheading or "none stated" is text', () => {
  assert.deepEqual(codes('# Title\n\n## Requirement\n\n## Impact\n\nThe vault is drained.\n'), ['EMPTY_REQUIREMENT_SECTION']);
  assert.deepEqual(codes('# Title\n\nThe vault is drained.\n\n## Requirement\n   \n'), ['EMPTY_REQUIREMENT_SECTION']);
  assert.deepEqual(codes('# Title\n\n## Requirement\n\n### In the code\n\nNothing in the code or the listing states it.\n\n## Impact\n'), []);
  assert.deepEqual(codes('# Title\n\n## Requirement\n\nNothing in the code or the listing states it.\n'), []);
  // one section with text is enough
  assert.deepEqual(codes('## Requirement\n\n## Requirement\n\nsrc/Vault.sol:42\n'), []);
  const [w] = requirementWarnings(Buffer.from('## Requirement\n'));
  assert.ok(w.detail.includes(REQUIREMENT));
});

test('a report.md the gate refuses gets no requirement warning: the gate says what is wrong', () => {
  assert.deepEqual(requirementWarnings(null), []);
  assert.deepEqual(requirementWarnings(Buffer.from([0xff, 0xfe, 0x00])), []);
  assert.deepEqual(requirementWarnings(Buffer.from('   \n')), []);
});

test('the help and the README say reveal --retrigger prints its cost and sends only with --yes, as the other paying verbs', () => {
  assert.match(USAGE, /^ {2}reveal <claim-dir> \[--retrigger\] \[--yes\]$/m);
  assert.match(USAGE, /--retrigger .*prints it, and sends only with --yes/);
  assert.match(USAGE, /appeal .*\n.*prints it, and sends only with --yes/);
  assert.match(flat(HUNTER), /verdikta-attest reveal \.\/claim --retrigger --yes/);
  assert.match(flat(HUNTER), /`reveal --retrigger` .*prints what it costs.*sends nothing without `--yes`/);
});
