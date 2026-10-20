#!/usr/bin/env node
// Repository-only packaging step: copy the website's shared wager module (example-bounty-program/shared/mutualWager.js,
// the code the create page, the bounty server's /api/wagers and its /jobs/create check run) into this skill, so wager.js
// builds and checks wagers with exactly that code. test/wager-parity.test.js fails until this has been run after a
// change to the shared module.
import { readFile, writeFile } from 'node:fs/promises';
const HEADER = [
  '// VENDORED from example-bounty-program/shared/mutualWager.js (the create page, /api/wagers and the /jobs/create check).',
  '// Every line below this header is that file, byte for byte: test/wager-parity.test.js fails when they differ.',
  '// Change the shared module first, then copy it here with: node sync_wager_assets.js',
  '// ---- end of vendored header ----',
  '',
].join('\n');
const source = await readFile(new URL('../../../example-bounty-program/shared/mutualWager.js', import.meta.url), 'utf8');
await writeFile(new URL('_mutual-wager.cjs', import.meta.url), HEADER + source);
