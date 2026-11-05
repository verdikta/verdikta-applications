// Spike runner: build each wager-escrow-v1 package, push it through the arbiter's own
// manifest validation/parsing (@verdikta/common, local checkout = 1.8.0), then send the
// parsed query to a local AI node exactly as the external adapter would (prompt, models,
// iterations, outcomes).
//
// Usage: node runJury.mjs <cases.json> <outDir> [samples=2] [caseIdFilter]
// Env: AI_NODE_PORT (default 3078), VERDIKTA_COMMON (path to a verdikta-common checkout)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildPackage, OUTCOMES } from './buildWagerPackage.mjs';

const require = createRequire(import.meta.url);
// VERDIKTA_COMMON = a verdikta-common checkout; otherwise the installed @verdikta/common package.
const common = process.env.VERDIKTA_COMMON
  ? require(path.join(process.env.VERDIKTA_COMMON, 'src/index.js'))
  : require('@verdikta/common');
const [casesFile, outDir, samplesArg, filter] = process.argv.slice(2);
const samples = Number(samplesArg || 2);
const port = process.env.AI_NODE_PORT || '3078';
const cfg = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const { manifestParser } = common.createClient({ logging: { level: 'error' } });
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

async function call(body) {
  const t0 = Date.now();
  const res = await fetch(`http://localhost:${port}/api/rank-and-justify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, ms: Date.now() - t0, ...json };
}

const rows = [];
for (const c of cfg.cases) {
  if (filter && !c.id.includes(filter)) continue;
  const dir = path.join(outDir, c.id, 'package');
  fs.mkdirSync(dir, { recursive: true });
  const files = buildPackage({ ...c.terms, jury: cfg.jury });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);

  // Arbiter-side validation + parse (throws on any schema or outcomes-count problem).
  const parsed = await quiet(() => manifestParser.parse(dir));
  if (JSON.stringify(parsed.outcomes) !== JSON.stringify(OUTCOMES)) throw new Error(`${c.id}: outcomes not preserved`);

  for (let s = 0; s < samples; s++) {
    const r = await call({ prompt: parsed.prompt, models: parsed.models, iterations: parsed.iterations, outcomes: parsed.outcomes });
    fs.writeFileSync(path.join(outDir, c.id, `sample${s + 1}.json`), JSON.stringify(r, null, 2));
    const scores = (r.scores || []).map((x) => x.score);
    const top = scores.length === 3 ? OUTCOMES[scores.indexOf(Math.max(...scores))] : 'INVALID';
    const decisive = scores.length === 3 && (scores[1] >= 800000 || scores[2] >= 800000);
    const verdict = scores.length !== 3 ? 'INVALID' : decisive ? top : 'NO_WINNER';
    const row = { id: c.id, sample: s + 1, expect: c.expect, verdict, ok: verdict === c.expect, scores: scores.join('/'),
      perModel: (r.model_results || r.modelResults || []).map((m) => `${m.model}:${m.status}`).join(' '), ms: r.ms };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
const pass = rows.filter((r) => r.ok).length;
console.log(`\n${pass}/${rows.length} samples match the expected outcome (decisive = SIDE score >= 800000)`);
