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

test('what the CLI itself prints across a claim\'s life passes the wording check', async () => {
  const { closeRpc, runCli } = await import('./helpers/cli.js');
  const { makeClaimDir, makeWorld, vectorOf, JUSTIFICATION_CID } = await import('./helpers/world.js');
  const { startRunner, TOKEN } = await import('./helpers/runner.js');
  const w = await makeWorld();
  const runner = await startRunner();
  try {
    const l = await w.listing();
    const dir = makeClaimDir();
    const outs = [];
    const run = async (args, o) => {
      const r = await runCli(w, args, o);
      assert.equal(r.code, 0, `${args[0]}: ${r.stderr}`);
      outs.push(r.stdout, r.stderr);
    };
    await run(['check', dir, '--listing', String(l.listingId), '--no-pack'], { runner: { url: runner.url, token: TOKEN } });
    await run(['commit', dir, '--listing', String(l.listingId), '--yes']);
    await run(['status', dir]);
    await run(['reveal', dir]);
    await run(['status', dir]);
    const { claimId } = JSON.parse(fs.readFileSync(path.join(dir, '.verdikta-claim', 'state.json'), 'utf8'));
    await (await w.aggregator.scriptResult((await w.sa.getClaim(claimId)).requestId, vectorOf('INVALID'), JUSTIFICATION_CID)).wait();
    await run(['claim', dir]);
    assert.deepEqual(wordingProblems(outs.join('\n')), []);
  } finally {
    await runner.close();
    await closeRpc(w);
    await w.close();
  }
});

test('the notices and every error message pass the wording check', async () => {
  const { commitNotice, forecastFooter, ERROR_TEXTS, USAGE } = await import('../src/index.js');
  const listing = { listingId: 7n, bondWei: 1n, priceWei: 2n, feeWei: 1n, disclosureWindowSeconds: 3600n, awards: [0n, 1n, 2n, 3n], lowestClass: 'MEDIUM', state: 'Open', invited: false, maker: `0x${'11'.repeat(20)}`, fixWindow: 0n, revealWindow: 1n, disputeWindow: 1n, repo: 'https://example.invalid/r', baseCommit: 'a'.repeat(40) };
  for (const text of [commitNotice(listing), forecastFooter(), USAGE, ...Object.values(ERROR_TEXTS)]) {
    assert.deepEqual(wordingProblems(text), [], text);
  }
});
