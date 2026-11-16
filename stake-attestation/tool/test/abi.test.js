// The ABI the tool runs with is the merged ABI of the contracts in ../onchain (`npm run abi` rewrites it).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAKE_ATTESTATION_ABI } from '../src/abi.js';
import { KNOWN_REVERTS } from '../src/errors.js';
import { hardhat, mergedAbi } from './helpers/chain.js';

test('every revert string of the contracts is on the allow-list, the only text repeated from a failure', () => {
  const dir = fileURLToPath(new URL('../../onchain/contracts', import.meta.url));
  const found = new Set();
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    if (!f.endsWith('.sol') || f.startsWith('mocks') || f.startsWith('test')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:require\((?:[^;]*?),\s*|revert\()"([^"]+)"\)/g)) found.add(m[1]);
  }
  assert.ok(found.size > 50, String(found.size));
  assert.deepEqual([...found].filter((r) => !KNOWN_REVERTS.includes(r)), []);
});

test('the committed ABI is onchain\'s merged ABI', async () => {
  assert.deepEqual(STAKE_ATTESTATION_ABI, mergedAbi(await hardhat()));
});
