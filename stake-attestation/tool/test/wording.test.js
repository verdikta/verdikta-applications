// The tool passes the repository's banned-words and judgemental-phrase checks: its source, and every string it
// says to a hunter of its own (relayed text from a runner is quoted as the runner's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findForbiddenWords, wordingProblems } from '@verdikta/stake-attestation-shared';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

test('no banned word anywhere in the tool\'s source', () => {
  for (const f of fs.readdirSync(SRC, { recursive: true })) {
    const p = path.join(SRC, f);
    if (!fs.statSync(p).isFile()) continue;
    assert.deepEqual(findForbiddenWords(fs.readFileSync(p, 'utf8')), [], f);
  }
});

test('the notices and every error message pass the wording check', async () => {
  const { commitNotice, forecastFooter, ERROR_TEXTS, USAGE } = await import('../src/index.js');
  const listing = { listingId: 7n, bondWei: 1n, priceWei: 2n, feeWei: 1n, disclosureWindowSeconds: 3600n, awards: [0n, 1n, 2n, 3n], lowestClass: 'MEDIUM', state: 'Open', invited: false, maker: `0x${'11'.repeat(20)}`, fixWindow: 0n, revealWindow: 1n, disputeWindow: 1n, repo: 'https://example.invalid/r', baseCommit: 'a'.repeat(40) };
  for (const text of [commitNotice(listing), forecastFooter(), USAGE, ...Object.values(ERROR_TEXTS)]) {
    assert.deepEqual(wordingProblems(text), [], text);
  }
});
