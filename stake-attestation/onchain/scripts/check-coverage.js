#!/usr/bin/env node
// The coverage gate (`npm run coverage:check`, after `hardhat coverage`): exit 1 unless every
// production contract, and all of them together, has at least MIN_LINE_PCT line coverage.
// Production contracts are every .sol file under contracts/ except mocks/, test/ (the harness)
// and interfaces/, which .solcover.js does not instrument; one with no figure in the summary
// fails the gate rather than passing unseen.
//
// Usage: node scripts/check-coverage.js [coverage/coverage-summary.json]
"use strict";
const fs = require("fs");
const path = require("path");

const MIN_LINE_PCT = 95;
const EXCLUDED_DIRS = ["mocks", "test", "interfaces"];

// The production contracts under `dir`, as paths relative to it ("libraries/ClaimLogic.sol").
function productionContracts(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!(rel === "" && EXCLUDED_DIRS.includes(e.name))) walk(r);
      } else if (e.name.endsWith(".sol")) {
        out.push(r);
      }
    }
  };
  walk("");
  return out.sort();
}

// Istanbul's json-summary: { total, "<file path>": { lines: { total, covered, pct } } }. A file
// with no lines (only internal library code inlined elsewhere) counts as fully covered.
function check(summary, files, min = MIN_LINE_PCT) {
  const entries = Object.entries(summary).filter(([k]) => k !== "total");
  const figureOf = (rel) => entries.find(([k]) => k.replace(/\\/g, "/").endsWith(`contracts/${rel}`));
  const rows = [];
  const errors = [];
  let total = 0;
  let covered = 0;
  for (const rel of files) {
    const found = figureOf(rel);
    if (!found) {
      errors.push(`${rel}: no coverage figure in the summary`);
      continue;
    }
    const { lines } = found[1];
    const pct = lines.total === 0 ? 100 : Number(lines.pct);
    total += lines.total;
    covered += lines.covered;
    rows.push(`  ${pct.toFixed(2).padStart(6)}%  ${lines.covered}/${lines.total}  ${rel}`);
    if (!(pct >= min)) errors.push(`${rel}: ${pct}% of lines covered, below ${min}%`);
  }
  const all = total === 0 ? 100 : (100 * covered) / total;
  if (!(all >= min)) errors.push(`all production contracts: ${all.toFixed(2)}% of lines covered, below ${min}%`);
  return { ok: errors.length === 0, rows, all, errors };
}

function main(argv = process.argv.slice(2)) {
  const root = path.join(__dirname, "..");
  const file = argv[0] || path.join(root, "coverage", "coverage-summary.json");
  if (!fs.existsSync(file)) {
    console.error(`coverage:check: ${file} not found; run \`hardhat coverage\` first (.solcover.js writes json-summary)`);
    return 1;
  }
  const summary = JSON.parse(fs.readFileSync(file, "utf8"));
  const files = productionContracts(path.join(root, "contracts"));
  const { ok, rows, all, errors } = check(summary, files);
  console.log(`Line coverage of the production contracts (gate: ${MIN_LINE_PCT}% each and overall):`);
  for (const r of rows) console.log(r);
  console.log(`  ${all.toFixed(2).padStart(6)}%  overall`);
  for (const e of errors) console.error(`coverage:check: ${e}`);
  return ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { MIN_LINE_PCT, productionContracts, check, main };
