// Records documents.pack.json: the context pack the arbiters' code-runner at the arbiter pin builds for a claim on a
// listing that names stake.documents. It runs the runner's own run engine and pack code (test/helpers/claimRun.js
// runClaim) over git objects its test/helpers/gitStore.js writes, in its own fake sandbox, so nothing here imitates the
// runner: the tool's tests show what this pack holds. Run it again when the pin moves (README, "Moving the arbiter pin"):
//
//   node documents.record.cjs <verdikta-arbiter at the pin>/code-runner documents.pack.json <its commit, 7 characters>
//
// The arbiter checkout needs its code-runner dependencies installed (the local round's e2e/.arbiter/<commit> has them).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [runnerDir, out, commit] = process.argv.slice(2);
if (!runnerDir || !out || !/^[0-9a-f]{7}$/.test(commit || '')) {
  process.stderr.write('usage: node documents.record.cjs <code-runner dir> <out.json> <arbiter commit, 7 characters>\n');
  process.exit(64);
}
const cr = path.resolve(runnerDir);
const { claimSandbox } = require(path.join(cr, 'test/helpers/fakeClaim'));
const { GitStore } = require(path.join(cr, 'test/helpers/gitStore'));
const { claimRequest, finding, runClaim, forgeSpec } = require(path.join(cr, 'test/helpers/claimRun'));

const DOCUMENTS = ['README.md', 'docs/**', 'SPEC/**'];

(async () => {
  const store = new GitStore('sha1');
  const dep = store.repo({ 'src/Test.sol': '// forge-std\n', 'README.md': '# forge-std\n' }, 'forge-std');
  const files = {
    '.gitmodules': '[submodule "lib/forge-std"]\n\tpath = lib/forge-std\n\turl = https://github.com/foundry-rs/forge-std\n',
    'foundry.toml': '[profile.default]\n',
    'lib/forge-std': { gitlink: dep },
    'src/Vault.sol': 'contract Vault {}\n',
    'test/Vault.t.sol': 'contract VaultTest {}\n',
    'README.md': '# Vault\nA deposit credits exactly the amount it receives.\n',
    'docs/spec.md': '# Vault specification\nbalanceOf grows by the amount deposited, and by nothing more.\n',
    'docs/diagram.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
  };
  const base = store.repo(files, 'base');
  const request = claimRequest();
  const spec = forgeSpec({ stake: { scope: { include: ['src/**'] }, documents: DOCUMENTS } });
  spec.baseCommit = base;
  const req = { ...request, spec, baseline: { ...request.baseline, baseCommit: base }, finding: finding({ affectedPaths: ['src/Vault.sol'] }) };
  const r = await runClaim(claimSandbox({ image: { store, base, dep, files } }), req);
  if (r.outcome !== 'definitive') throw new Error(`the run was ${r.outcome}: ${JSON.stringify(r.abstain || r.issues)}`);
  const recorded = {
    recordedFrom: 'verdikta-arbiter code-runner at the arbiter pin (e2e/arbiter.pin.json): a claim run through its own run engine and pack code (test/helpers/claimRun.js runClaim, over git objects test/helpers/gitStore.js writes, in its fake sandbox) by documents.record.cjs, on a listing whose stake.documents is the one below; the listed commit holds README.md, docs/spec.md and docs/diagram.bin (not text)',
    arbiterCommit: commit,
    documents: DOCUMENTS,
    contextPack: r.contextPack,
  };
  fs.writeFileSync(out, `${JSON.stringify(recorded, null, 1)}\n`);
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
