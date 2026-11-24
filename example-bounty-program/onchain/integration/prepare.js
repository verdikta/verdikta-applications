#!/usr/bin/env node
// Copies the sources the integration suite compiles into integration/.contracts/ (git-ignored):
//   apps/        this package's contracts (no mocks)
//   dispatcher/  verdikta-dispatcher's v2 contracts, from VERDIKTA_DISPATCHER_DIR or the sibling
//                checkout ../../../../dispatcher/reputationBasedAggregator (check out its `beacon` branch).
const fs = require("fs");
const path = require("path");

const here = __dirname;
const out = path.join(here, ".contracts");
const dispatcher = path.resolve(process.env.VERDIKTA_DISPATCHER_DIR || path.join(here, "../../../../dispatcher/reputationBasedAggregator"));
const dispatcherContracts = path.join(dispatcher, "contracts");
if (!fs.existsSync(path.join(dispatcherContracts, "ReputationAggregator.sol"))) {
  console.error(`No v2 ReputationAggregator.sol under ${dispatcherContracts}.\n` +
    "Check out verdikta-dispatcher (branch beacon) beside verdikta-applications, or set VERDIKTA_DISPATCHER_DIR to its reputationBasedAggregator folder.");
  process.exit(1);
}
const copyDir = (from, to, skip = () => false) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, skip);
    else if (e.name.endsWith(".sol")) fs.copyFileSync(a, b);
  }
};
fs.rmSync(out, { recursive: true, force: true });
copyDir(path.join(here, "..", "contracts"), path.join(out, "apps"), (name) => name === "mocks");
copyDir(dispatcherContracts, path.join(out, "dispatcher"));
console.log(`integration sources: ${path.relative(process.cwd(), out)} (dispatcher from ${dispatcher})`);
