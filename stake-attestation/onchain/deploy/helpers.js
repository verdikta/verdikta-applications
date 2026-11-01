// Deployment helpers, as example-bounty-program/onchain/deploy/helpers.js: the deployment record
// and the merged ABI (StakeAttestation + StakeAttestationLens).
const fs = require("fs");
const path = require("path");

const DEFAULT_DIR = path.join(__dirname, "..", "deployments"); // untracked (stake-attestation/.gitignore)

function writeJson(file, data) {
  // BigInt-safe, as the bounty program's saveDeployment.
  fs.writeFileSync(file, JSON.stringify(data, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

// deployments/<chainId>-<network>.json: the addresses, the deployment block (the indexer's
// start), the constructor arguments and the linked libraries, for verify.js and the site.
function saveDeployment(out, dir = DEFAULT_DIR, log = console.log) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${out.chainId}-${out.network}.json`);
  writeJson(file, out);
  log(`Saved the deployment to ${file}`);
  return file;
}

function readDeployment(chainId, network, dir = DEFAULT_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${chainId}-${network}.json`), "utf8"));
}

// One ABI fragment's key, for de-duplication (type, name and input types).
function fragmentKey(f) {
  const inputs = (f.inputs || []).map((i) => i.internalType || i.type).join(",");
  return `${f.type}:${f.name || ""}(${inputs})`;
}

/**
 * StakeAttestation's canonical ABI: its own fragments plus the read-only views and events
 * StakeAttestationLens answers AT THE StakeAttestation ADDRESS through its fallback
 * (claimState, claimTimes, commitPrice, revealTopUp, recordByHash, recordPage, ...). The
 * compiled StakeAttestation artifact alone lacks them, so attach this one to the address.
 */
function mergedAbi(artifacts) {
  const main = artifacts.readArtifactSync("StakeAttestation").abi;
  const lens = artifacts.readArtifactSync("StakeAttestationLens").abi;
  const seen = new Set(main.map(fragmentKey));
  const extra = lens.filter(
    (f) => ["function", "event", "error"].includes(f.type) && !seen.has(fragmentKey(f)) && f.name !== "host"
  );
  return [...main, ...extra];
}

// deployments/StakeAttestation.abi.json, artifact-shaped ({ contractName, abi }).
function writeMergedAbi(artifacts, dir = DEFAULT_DIR, log = console.log) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "StakeAttestation.abi.json");
  writeJson(file, {
    _format: "merged-abi-v1",
    contractName: "StakeAttestation",
    note: "StakeAttestation ABI + StakeAttestationLens views. Every function is callable at the StakeAttestation address (it forwards lens selectors through a static delegatecall fallback).",
    abi: mergedAbi(artifacts),
  });
  log(`Wrote the merged ABI to ${file}`);
  return file;
}

// Load-balanced RPCs can lag a block or two behind a receipt and answer eth_call with empty
// data: retry a read after a deploy instead of aborting (as the bounty program's script does).
async function readWithRetry(label, fn, log = console.log, { tries = 10, delayMs = 3000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      log(`  ${label}: RPC not caught up yet (${e.shortMessage || e.message}); retry ${i}/${tries - 1} in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { DEFAULT_DIR, saveDeployment, readDeployment, mergedAbi, writeMergedAbi, readWithRetry };
