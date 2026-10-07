// The bundled preview CLI is what an agent with a shell runs: it must equal a fresh build, run with nothing but Node,
// and give exactly what preview() gives for every kind of input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { preview, previewText, checkSummary, templates } from '../scripts/preview-core.mjs';
import { build, BUNDLE, CHECK_BUNDLE, NOTICES } from '../scripts/build-bundle.mjs';
import { composeEvaluationDescription } from '../scripts/work-order.mjs';

const root = new URL('../', import.meta.url);
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const TARGET = '0x52908400098527886E0F7030069857D2E4169EE7';

test('the committed bundle and notices equal a fresh build (run `npm run bundle` after changing the preview code)', async () => {
  const fresh = await build();
  assert.equal(await readFile(BUNDLE, 'utf8'), fresh.bundle);
  assert.equal(await readFile(CHECK_BUNDLE, 'utf8'), fresh.checkBundle);
  assert.equal(await readFile(NOTICES, 'utf8'), fresh.notices);
});

test('the bundles import nothing but Node built-ins', async () => {
  for (const file of [BUNDLE, CHECK_BUNDLE]) {
    const text = await readFile(file, 'utf8');
    const imports = [...text.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map(m => m[1]);
    assert.ok(imports.length > 0);
    assert.deepEqual(imports.filter(s => !s.startsWith('node:')), [], file);
  }
});

test('alone in an empty directory, the bundle gives what preview() gives, from a file and from standard input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verdikta-bundle-'));
  try {
    const cli = join(dir, 'preview.bundle.mjs');
    await copyFile(BUNDLE, cli);
    const sourceCheck = await json('examples/assessment.json');
    const packRequest = { ...(await json('examples/evidence-pack-v1.request.json')), fixture_only: false };
    const inputs = {
      open: sourceCheck,
      hybrid: await json('examples/assessment-hybrid.json'),
      targeted: { request: packRequest, sharing_authorized: true, procurement_mode: 'TARGETED', targetHunter: TARGET, network: 'BASE_SEPOLIA' },
      no_sharing: { ...sourceCheck, sharing_authorized: undefined },
      declined: { ...sourceCheck, sharing_authorized: false },
      undecided_supplier: { ...sourceCheck, procurement_mode: 'UNSELECTED' },
      bad_market: { ...(await json('examples/assessment-hybrid.json')), market_context: { source_url: 'http://example.com/x?y=1', not_a_quote: false } },
      bad_summary: { ...(await json('examples/assessment-hybrid.json')), local_summary: { mode: 'RESIDUAL', independent: true } },
    };
    for (const [name, input] of Object.entries(inputs)) {
      const want = JSON.stringify(preview(structuredClone(input)), null, 2) + '\n';
      const file = join(dir, `${name}.json`);
      await writeFile(file, JSON.stringify(input));
      const fromFile = spawnSync(process.execPath, [cli, file], { cwd: dir, encoding: 'utf8' });
      assert.equal(fromFile.status, 0, `${name}: ${fromFile.stderr}`);
      assert.equal(fromFile.stdout, want, name);
      const fromStdin = spawnSync(process.execPath, [cli, '-'], { cwd: dir, encoding: 'utf8', input: JSON.stringify(input) });
      assert.equal(fromStdin.stdout, want, `${name} (stdin)`);
      // --check: the short summary an agent reads, whose draft_sha256 is the hash of the full output above.
      const sha = text => createHash('sha256').update(text).digest('hex');
      const summary = `${JSON.stringify(checkSummary(preview(structuredClone(input)), sha), null, 2)}\n`;
      for (const args of [['--check', file], ['--check', '-']]) {
        const checked = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', input: JSON.stringify(input) });
        assert.equal(checked.status, 0, `${name} ${args}: ${checked.stderr}`);
        assert.equal(checked.stdout, summary, `${name} ${args}`);
        assert.equal(JSON.parse(checked.stdout).draft_sha256, JSON.parse(want).draft ? sha(want) : null, `${name} ${args}`);
      }
    }
    const listed = spawnSync(process.execPath, [cli, '--templates'], { cwd: dir, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(listed.stdout), templates);
    const bad = spawnSync(process.execPath, [cli, '-'], { cwd: dir, encoding: 'utf8', input: 'not json' });
    assert.equal(bad.status, 1);
    assert.equal(spawnSync(process.execPath, [cli, '--check'], { cwd: dir, encoding: 'utf8' }).status, 1, '--check without an input is a usage error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the hybrid input example produces the hybrid preview example exactly', async () => {
  assert.deepEqual(preview(await json('examples/assessment-hybrid.json')), await json('examples/preview-hybrid.json'));
});

test('previewText is exactly what the CLI prints, and checkSummary reports what an agent needs and nothing it could paste as a draft', async () => {
  const input = await json('examples/assessment-hybrid.json'), result = preview(structuredClone(input));
  assert.equal(previewText(result), `${JSON.stringify(result, null, 2)}\n`);
  const s = checkSummary(result, () => 'HASH');
  assert.deepEqual(Object.keys(s), ['decision', 'reason', 'inputs_needed', 'template_id', 'drafted_items', 'local_summary', 'market_context_included', 'draft_sha256', 'deliver']);
  assert.equal(s.decision, 'PREVIEW'); assert.deepEqual(s.drafted_items, ['C3']); assert.deepEqual(s.local_summary, { mode: 'RESIDUAL', resolved: 2, residual: 1 });
  assert.equal(s.market_context_included, true); assert.equal(s.draft_sha256, 'HASH');
  assert.equal(JSON.stringify(s).includes('rubric'), false, 'no draft fields leak into the summary');
  const none = checkSummary(preview({ ...input, sharing_authorized: undefined }), () => 'HASH');
  assert.equal(none.decision, 'NEEDS_SCOPE'); assert.equal(none.draft_sha256, null); assert.deepEqual(none.drafted_items, []); assert.ok(none.inputs_needed.includes('Obtain sharing approval'));
});

test('alone in an empty directory, the check bundle validates a result against the description the composer wrote, and against a request file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verdikta-check-'));
  try {
    const cli = join(dir, 'check-result.bundle.mjs');
    await copyFile(CHECK_BUNDLE, cli);
    for (const kind of ['source-check-v1', 'evidence-pack-v1', 'review-v1', 'real-world-task-v1']) {
      const requestText = await readFile(new URL(`examples/${kind}.request.json`, root), 'utf8');
      const result = await json(`examples/${kind}.result.json`);
      const requestFile = join(dir, `${kind}.request.json`), resultFile = join(dir, `${kind}.result.json`);
      await writeFile(requestFile, requestText); await writeFile(resultFile, JSON.stringify(result));
      // --request: the digest is that of the file's exact bytes; the example results carry it. Fixtures need --allow-fixture.
      const byRequest = spawnSync(process.execPath, [cli, '--request', requestFile, '--result', resultFile, '--allow-fixture'], { cwd: dir, encoding: 'utf8' });
      assert.equal(byRequest.status, 0, `${kind}: ${byRequest.stdout} ${byRequest.stderr}`);
      assert.deepEqual(JSON.parse(byRequest.stdout).errors, []);
      const production = spawnSync(process.execPath, [cli, '--request', requestFile, '--result', resultFile], { cwd: dir, encoding: 'utf8' });
      assert.equal(production.status, 1, `${kind}: a fixture is refused for production`);
      // --description: a real-shaped request committed by the composer; the result must carry the digest of the committed line.
      const request = { ...JSON.parse(requestText), fixture_only: false, task_id: `${kind}-real` };
      const { description, requestDigest } = composeEvaluationDescription({ baseDescription: 'Owner text', draftSha256: 'a'.repeat(64), templateId: kind, request });
      const descriptionFile = join(dir, `${kind}.description.txt`), realResult = join(dir, `${kind}.real.json`);
      await writeFile(descriptionFile, description);
      // A real result cannot cite synthetic fixtures: the examples' sources become buyer-provided corpus entries.
      const realised = { ...result, fixture_only: false, task_id: request.task_id, input_sha256: requestDigest, ...(result.sources ? { sources: result.sources.map(s => ({ ...s, provenance: 'BUYER_PROVIDED' })) } : {}) };
      await writeFile(realResult, JSON.stringify(realised));
      const byDescription = spawnSync(process.execPath, [cli, '--description', descriptionFile, '--result', realResult], { cwd: dir, encoding: 'utf8' });
      assert.equal(byDescription.status, 0, `${kind}: ${byDescription.stdout} ${byDescription.stderr}`);
      const parsed = JSON.parse(byDescription.stdout);
      assert.equal(parsed.ok, true); assert.equal(parsed.template_id, kind); assert.equal(parsed.input_sha256, requestDigest);
      const stale = spawnSync(process.execPath, [cli, '--description', descriptionFile, '--result', resultFile, '--allow-fixture'], { cwd: dir, encoding: 'utf8' });
      assert.equal(stale.status, 1, `${kind}: a result for another request (wrong task_id and digest) is refused`);
    }
    const noOrder = join(dir, 'plain.txt'); await writeFile(noOrder, 'A plain bounty with no work order.');
    const none = spawnSync(process.execPath, [cli, '--description', noOrder, '--result', join(dir, 'review-v1.result.json')], { cwd: dir, encoding: 'utf8' });
    assert.equal(none.status, 1); assert.match(JSON.parse(none.stdout).errors[0], /no work order/);
    assert.equal(spawnSync(process.execPath, [cli], { cwd: dir, encoding: 'utf8' }).status, 1, 'usage error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
