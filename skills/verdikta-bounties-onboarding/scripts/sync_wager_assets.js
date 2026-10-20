#!/usr/bin/env node
// Repository-only packaging step: copy the website's wager terms helper and its Mutual Wager rubric template into
// this skill, so wager.js builds and checks terms with the same code as the create page. test/wager-parity.test.js
// fails until this has been run after a change to either site file.
import { readFile, writeFile } from 'node:fs/promises';
const client = new URL('../../../example-bounty-program/client/src/', import.meta.url);
const VENDORED_HEADER = [
  '// VENDORED from example-bounty-program/client/src/utils/mutualWagerTerms.js (the website\'s create page).',
  '// Every line below this header is that file, byte for byte: test/wager-parity.test.js fails when they differ.',
  '// Change the site\'s file first, then copy it here with: node sync_wager_assets.js',
  '// ---- end of vendored header ----',
  '',
].join('\n');
const source = await readFile(new URL('utils/mutualWagerTerms.js', client), 'utf8');
await writeFile(new URL('_mutual-wager-terms.js', import.meta.url), VENDORED_HEADER + source);
const { getTemplate } = await import(new URL('data/rubricTemplates.js', client));
await writeFile(new URL('mutual-wager-template.json', import.meta.url), JSON.stringify(getTemplate('mutualWager'), null, 2) + '\n');
