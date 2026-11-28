#!/usr/bin/env node
// `npm run test:quick`: the contract tests for everyday use, a few minutes instead of the full
// suite's half hour. It runs every test file except the long-running ones named below, so a new
// test file is in the quick run unless it is added here.
//
// Run the FULL suite (`npm test`) periodically, before a review package, and always before a
// deployment: only it has the random-sequence funds-conservation check and the differential check
// against @verdikta/common, which are what catch an accounting or settlement change the unit tests
// did not think of.
//
//   npm run test:quick                 every quick file
//   npm run test:quick -- claims hold  only the quick files whose name contains "claims" or "hold"
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// file -> why it is left to the full suite
const SLOW = {
  "StakeAttestation.invariant.test.js": "12 random call sequences checking funds conservation after every step (most of the full run)",
  "StakeAttestation.differential.test.js": "settlement compared with @verdikta/common over thousands of vectors",
  "smoke.test.js": "starts a JSON-RPC server and a stub site and spawns the launch smoke script",
};

const root = path.resolve(__dirname, "..");
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = fs.readdirSync(path.join(root, "test"))
  .filter((f) => f.endsWith(".test.js") && !SLOW[f])
  .filter((f) => only.length === 0 || only.some((o) => f.toLowerCase().includes(o.toLowerCase())))
  .sort();

if (files.length === 0) {
  console.error(`no quick test file matches: ${only.join(", ")}`);
  process.exit(1);
}
console.log(`quick run: ${files.length} test files. Left to the full suite (npm test):`);
for (const [f, why] of Object.entries(SLOW)) console.log(`  - ${f}: ${why}`);

const started = Date.now();
const r = spawnSync("npx", ["hardhat", "test", ...files.map((f) => path.join("test", f))], { cwd: root, stdio: "inherit" });
console.log(`quick run took ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(r.status ?? 1);
