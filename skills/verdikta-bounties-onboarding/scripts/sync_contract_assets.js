#!/usr/bin/env node
// Repository-only packaging step; first compile via hardhat.local.cjs (no secrets). Writes bounty-escrow.abi.json,
// rubric.cjs and _class-presets.cjs.
import { readFile, writeFile } from 'node:fs/promises';
import { Interface } from 'ethers';
const contracts = new URL('../../../example-bounty-program/onchain/artifacts/contracts/', import.meta.url);
const escrow = JSON.parse(await readFile(new URL('BountyEscrow.sol/BountyEscrow.json', contracts))).abi;
const lens = JSON.parse(await readFile(new URL('BountyEscrowLens.sol/BountyEscrowLens.json', contracts))).abi;
const merged = new Interface([...escrow, ...lens.filter(f => f.type === 'function' && !escrow.some(e => e.type === f.type && e.name === f.name))]);
await writeFile(new URL('bounty-escrow.abi.json', import.meta.url), JSON.stringify(JSON.parse(merged.formatJson()), null, 2) + '\n');
const source = await readFile(new URL('../../../example-bounty-program/server/utils/validation.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('function validateRubric('), source.indexOf('\n/**', source.indexOf('function validateRubric('))).trim();
await writeFile(new URL('rubric.cjs', import.meta.url), '// Generated from server/utils/validation.js by sync_contract_assets.js; do not edit.\n' + fn + '\nmodule.exports = { validateRubric };\n');
// The size-class presets (shared/classPresets.js, the create page's and the API's): vendored byte for byte under a
// header; test/class-presets.test.js fails when they differ.
const presets = await readFile(new URL('../../../example-bounty-program/shared/classPresets.js', import.meta.url), 'utf8');
await writeFile(new URL('_class-presets.cjs', import.meta.url), [
  '// VENDORED from example-bounty-program/shared/classPresets.js (the create page and /api/jobs/create presets).',
  '// Every line below this header is that file, byte for byte: test/class-presets.test.js fails when they differ.',
  '// Change the shared module first, then copy it here with: node sync_contract_assets.js',
  '// ---- end of vendored header ----',
  '',
].join('\n') + presets);
