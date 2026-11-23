#!/usr/bin/env node
/**
 * Build the MERGED BountyEscrow ABI that agents should use.
 *
 * The escrow answers every selector it does not implement itself by STATICCALLing
 * into BountyEscrowLens (see BountyEscrow.sol "Read-only extension (lens)"), so the
 * lens views (nextAction, getEffectiveBountyStatus, canBeClosed, getSubmissions,
 * getBounties, getOracleResult, ...) are callable AT THE ESCROW ADDRESS — but the
 * escrow's own verified/compiled ABI does not list them. Anyone who pulls the ABI
 * from a block explorer therefore gets an incomplete interface. This script merges
 * the two compiled artifacts into one ABI array and writes it to abi/BountyEscrow.json.
 *
 * Usage (after `npx hardhat compile`):
 *   node scripts/build-merged-abi.js            # writes abi/BountyEscrow.json
 *   node scripts/build-merged-abi.js --check    # exits 1 if the file is stale
 *
 * Re-run this on every contract change and commit the output together with the
 * new deployment record (see deploy/CUTOVER-*.md).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const escrowArtifact = path.join(root, 'artifacts/contracts/BountyEscrow.sol/BountyEscrow.json');
const lensArtifact = path.join(root, 'artifacts/contracts/BountyEscrowLens.sol/BountyEscrowLens.json');
const outFile = path.join(root, 'abi/BountyEscrow.json');

// Lens entries that are implementation details of the lens itself, not part of
// the escrow's public interface (constructor/fallback are duplicates of the
// escrow's; `escrow()` is the lens's back-pointer).
const LENS_SKIP = new Set(['constructor', 'fallback', 'receive']);
const LENS_SKIP_NAMES = new Set(['escrow']);

function sig(e) {
  return `${e.type}:${e.name || ''}(${(e.inputs || []).map(i => i.type).join(',')})`;
}

function build() {
  const escrow = JSON.parse(fs.readFileSync(escrowArtifact, 'utf8')).abi;
  const lens = JSON.parse(fs.readFileSync(lensArtifact, 'utf8')).abi;
  const seen = new Set(escrow.map(sig));
  const merged = [...escrow];
  for (const entry of lens) {
    if (LENS_SKIP.has(entry.type) || LENS_SKIP_NAMES.has(entry.name)) continue;
    const s = sig(entry);
    if (seen.has(s)) continue;
    seen.add(s);
    merged.push(entry);
  }
  return merged;
}

const merged = build();
const json = JSON.stringify(merged, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (current !== json) { console.error(`${outFile} is stale — run scripts/build-merged-abi.js`); process.exit(1); }
  console.log(`${outFile} is up to date (${merged.length} entries)`);
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, json);
  const counts = merged.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
  console.log(`wrote ${path.relative(root, outFile)}: ${merged.length} entries`, counts);
}
