// Node P20, acceptance 1: a listing without documents builds and signs byte for byte as before. The golden files
// in test/fixtures/no-documents/ were written by this test (SA_WRITE_GOLDEN=1) from verdikta-applications 028112c,
// before node P20 changed anything: the builder's files, the validation report after `sign`, and the statement
// `sign` wrote. What a run varies is set to fixed values first: the report's time, each step's duration, the local
// tag's random part, the dev key's id and the signature (a fresh dev key each run). Everything else, every key and
// its order included, is compared as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../src/cli.js';
import { REPOSITORY, writeAcceptedBuild } from '../helpers/build.js';
import { MAKER, provenAnswer } from '../helpers/proof.js';
import { draftSpec } from '../helpers/specs.js';

const GOLDEN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'no-documents');
const FIXED_TIME = '2026-11-11T00:00:00Z';
// a fixed disclosure key (an age recipient; specs.js draws a fresh one per run)
const RECIPIENT = 'age1fxxhpw5t88yync25uk0ph498jqeka8x834q2vfq7yqyre9k7gvesswmck3';
const DRAFT = () => draftSpec({ stake: { ...draftSpec().stake, disclosureKey: RECIPIENT } });

function normalizedReport(text) {
  const r = JSON.parse(text);
  r.createdAt = FIXED_TIME;
  for (const s of r.steps) s.durationMs = 0;
  if (r.image?.tag) r.image.tag = r.image.tag.replace(/-[0-9a-f]{8}$/, '-00000000');
  if (r.attestation) Object.assign(r.attestation, { keyId: 'KEY', issuedAt: FIXED_TIME, sha256: 'SHA256' });
  return `${JSON.stringify(r, null, 2)}\n`;
}

function normalizedStatement(text) {
  const a = JSON.parse(text);
  a.issuedAt = FIXED_TIME;
  if (a.signature) a.signature = { ...Object.fromEntries(Object.keys(a.signature).map((k) => [k, 'SIGNATURE'])) };
  return `${JSON.stringify(a, null, 2)}\n`;
}

async function buildAndSign() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-nodocs-'));
  try {
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    await writeAcceptedBuild(out, { draft: DRAFT() });
    const config = path.join(dir, 'builder.json');
    fs.writeFileSync(config, JSON.stringify({ registry: { repository: REPOSITORY }, runner: { url: 'http://127.0.0.1:8090', tokenEnv: 'CODE_RUNNER_TOKEN' } }));
    let err = '';
    const code = await main(['sign', '--config', config, '--dir', out, '--maker', MAKER], {
      env: {}, stdout: { write() {} }, stderr: { write: (s) => { err += s; } }, deps: { checkRepositoryControl: provenAnswer() },
    });
    assert.equal(code, 0, err);
    const read = (name) => fs.readFileSync(path.join(out, name), 'utf8');
    return {
      'code_review.json': read('code_review.json'),
      'baseline.json': read('baseline.json'),
      'validation-report.json': normalizedReport(read('validation-report.json')),
      'attestation.json': normalizedStatement(read('attestation.json')),
      files: fs.readdirSync(out).sort().join('\n'),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a listing without documents: its files, its report after sign and its statement are what they were before node P20', async () => {
  const made = await buildAndSign();
  if (process.env.SA_WRITE_GOLDEN === '1') {
    fs.mkdirSync(GOLDEN, { recursive: true });
    for (const [name, text] of Object.entries(made)) fs.writeFileSync(path.join(GOLDEN, name === 'files' ? 'files.txt' : name), text);
  }
  for (const [name, text] of Object.entries(made)) {
    assert.equal(text, fs.readFileSync(path.join(GOLDEN, name === 'files' ? 'files.txt' : name), 'utf8'), name);
  }
  assert.doesNotMatch(made['validation-report.json'], /documents/);
  assert.doesNotMatch(made['code_review.json'], /documents/);
});
