// What a round is about: a Foundry repository with a real bug, the project's proof at the listed
// commit naming the maker, the maker's draft, and the hunter's four claim folders.
//
// The repository is the builder's fixture (builder/test/fixtures/vault: Vault.deposit credits one wei
// too many), so the round lists what P3a's tests build. Its foundry.toml names solc 0.8.31, so the
// setup's forge installs an official release, which the listing check reads and the runner accepts.
// Two things are added: the proof file (docs/control-proof.md), and a gas limit no test reaches, so a
// looping proof runs into the runner's clock and not into forge's gas limit. Node P20: a second commit on top
// adds the maker's documents, for the round's second listing, which names them (stake.documents); the first
// listing is the first commit, as before.
import fs from 'node:fs';
import path from 'node:path';

import { APP_DIR } from './setup.js';
import { git } from './proc.js';

// On a host with no API the site knows, and named as one for this run: the record's fork label would
// otherwise read api.github.com. The mirror stands for it (SA_CONTROL_GIT_MIRROR_DIR, repoMirrors).
export const GIT_HOST = 'git.verdikta-e2e.invalid';
export const REPO_URL = `https://${GIT_HOST}/acme/vault`;
export const FORGE_COMMANDS = Object.freeze({
  framework: 'forge',
  setup: 'forge build',
  build: 'forge build',
  test: 'forge test',
  testFiles: 'forge test --match-path $FILES',
  testIds: 'forge test --match-test $TEST_IDS',
});
export const BOND_WEI = 20000000000000000n; // 0.02 ETH
export const AWARDS_WEI = Object.freeze({ LOW: 0n, MEDIUM: 10n ** 17n, HIGH: 4n * 10n ** 17n, CRITICAL: 2n * 10n ** 18n });
export const ESCROW_WEI = 3n * 10n ** 18n;
const HOUR = 3600;
const DAY = 24 * HOUR;
export const WINDOWS = Object.freeze({ fix: 14 * DAY, dispute: 72 * HOUR, grace: 48 * HOUR, reveal: 7 * DAY });

/**
 * Node P20 (owner decision Q61 (a)): the documents listing's globs, the files its commit adds for them, and what the
 * runner's tier is then expected to hold: the two text files in the listing's order, the binary one left out as not
 * text, and a glob that matches nothing (a warning in the builder's report, never a refusal).
 */
export const DOCUMENT_GLOBS = Object.freeze(['README.md', 'docs/**', 'SPEC/**']);
const DOCUMENT_FILES = Object.freeze({
  'README.md': '# Vault\n\nA deposit credits exactly the amount it receives: balanceOf grows by the amount, and by nothing more.\n',
  'docs/spec.md': '# Vault specification\n\ndeposit(amount) adds exactly amount to the sender\'s balanceOf.\n',
  'docs/diagram.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
});
export const DOCUMENTS_EXPECTED = Object.freeze({ read: ['README.md', 'docs/spec.md'], skipped: [['docs/diagram.bin', 'notText']], unmatched: ['SPEC/**'], omitted: { notText: 1 } });

/**
 * The repository as a bare mirror, at <mirrorsDir>/<host>/<path>.git: where the server's control
 * check looks (SA_CONTROL_GIT_MIRROR_DIR) and the builder's config points (repoMirrors).
 * @returns {{ url: string, mirror: string, mirrorsDir: string, baseCommit: string, documentsCommit: string }}
 */
export function makeRepository({ workDir, maker, proofMaker = maker }) {
  const work = path.join(workDir, 'repository');
  fs.cpSync(path.join(APP_DIR, 'builder', 'test', 'fixtures', 'vault'), work, { recursive: true });
  fs.appendFileSync(path.join(work, 'foundry.toml'), 'gas_limit = "9223372036854775807"\n');
  fs.mkdirSync(path.join(work, '.verdikta'), { recursive: true });
  fs.writeFileSync(path.join(work, '.verdikta', 'stake-control.json'), `${JSON.stringify({ version: 1, maker: proofMaker })}\n`);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'the listed version');
  const baseCommit = git(work, 'rev-parse', 'HEAD');
  for (const [file, bytes] of Object.entries(DOCUMENT_FILES)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), bytes);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'the listed version, with its documents');
  const documentsCommit = git(work, 'rev-parse', 'HEAD');
  const mirrorsDir = path.join(workDir, 'mirrors');
  const { host, pathname } = new URL(REPO_URL);
  const mirror = path.join(mirrorsDir, host, `${pathname.slice(1)}.git`);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  git(path.dirname(mirror), 'clone', '-q', '--bare', work, mirror);
  git(mirror, 'config', 'uploadpack.allowFilter', 'true');
  return { url: REPO_URL, mirror, mirrorsDir, baseCommit, documentsCommit };
}

/** The maker's draft: design §7.1's default windows, and limits a loaded machine's slow step fits in. */
export function draftSpec({ repo, baseCommit, disclosureKey, documents = null }) {
  return {
    version: 1,
    kind: 'bug',
    repo,
    baseCommit,
    env: { from: 'foundry' },
    attestation: 'attestation.json',
    commands: { ...FORGE_COMMANDS },
    baseline: 'baseline.json',
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    // The check's defaults are three times one measured run (2 s and 3 s here): a machine busy with
    // the rest of the round would abstain on them. A draft may ask for more.
    limits: { cpus: 1, memoryMb: 2048, buildSeconds: 30, testSeconds: 15, runSeconds: 150 },
    stake: {
      awards: { LOW: '0', MEDIUM: '0.1 ETH', HIGH: '0.4 ETH', CRITICAL: '2 ETH' },
      lowestClassCounted: 'MEDIUM',
      bondWei: BOND_WEI.toString(),
      fixWindowDays: WINDOWS.fix / DAY,
      disputeWindowHours: WINDOWS.dispute / HOUR,
      disclosureGraceHours: WINDOWS.grace / HOUR,
      revealWindowDays: WINDOWS.reveal / DAY,
      scope: { include: ['src/**'], exclude: ['test/**'] },
      ...(documents ? { documents: [...documents] } : {}),
      severityRubric: 'immunefi-v2.3',
      disclosureKey,
      valueAtRiskUsd: 1000,
    },
  };
}

const POC_HEADER = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\n\nimport {Vault} from "../src/Vault.sol";\nimport {Base} from "./Vm.sol";\n\n';
export const REPORT_MARKER = 'E2E-REPORT-MARKER-3f7c: deposit credits one wei more than it receives';
export const POC_MARKER = 'E2E-POC-MARKER-a91d';

function addFile(file, text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
}

const FINDING = Object.freeze({
  version: 1,
  title: 'Vault.deposit over-credits',
  claimedClass: 'HIGH',
  rootCause: 'Vault.deposit credits one wei more than it receives, so balances overstate deposits and the vault can be drained.',
  affectedPaths: ['src/Vault.sol'],
  poc: {
    command: 'forge test --match-test test_deposit_credits_exactly',
    observable: 'test_deposit_credits_exactly fails at the committed hash with "2 != 1"',
  },
  fixIncluded: false,
});

const CLAIMS = Object.freeze({
  // A proof that fails at the committed hash for the reason it names: every gate passes, the jury decides.
  valid: {
    finding: FINDING,
    poc: addFile('test/Exploit.t.sol', `${POC_HEADER}contract ExploitTest is Base {\n    // ${POC_MARKER}\n    function test_deposit_credits_exactly() public {\n        Vault v = new Vault();\n        v.deposit(1);\n        vm.assertEq(v.balanceOf(address(this)), 1);\n    }\n}\n`),
  },
  // A proof that edits the code under test: the real runner's testPathsOnly gate.
  gate: {
    finding: { ...FINDING, title: 'Vault.deposit over-credits, a proof that edits the source' },
    poc: 'diff --git a/src/Vault.sol b/src/Vault.sol\n--- a/src/Vault.sol\n+++ b/src/Vault.sol\n@@ -11,5 +11,5 @@\n \n     function deposit(uint256 amount) external {\n-        balanceOf[msg.sender] += amount + 1;\n+        balanceOf[msg.sender] += amount + 2;\n     }\n }\n',
  },
  // A proof that fails at the committed hash for the same reason as the valid one, and on its way writes a path the
  // listing protects: the runner's post-run checksums fail, and no tamper flag names .gitignore. So its results are not
  // trusted, and it settles DUPLICATE: bond back, no award (owner decision Q35).
  integrity: {
    finding: { ...FINDING, title: 'Vault.deposit over-credits, a proof that writes a protected file' },
    poc: addFile('test/Exploit.t.sol', `${POC_HEADER}interface VmFiles {\n    function writeFile(string calldata path, string calldata data) external;\n}\n\ncontract ExploitTest is Base {\n    /// forge-config: default.fs_permissions = [{ access = "read-write", path = "./.gitignore" }]\n    function test_deposit_credits_exactly() public {\n        VmFiles(address(vm)).writeFile(".gitignore", "out\\n");\n        Vault v = new Vault();\n        v.deposit(1);\n        vm.assertEq(v.balanceOf(address(this)), 1);\n    }\n}\n`),
  },
  // Node P18, erratum E7: a second proof that edits the code under test, which its hunter appeals through the tool.
  // The dispute panel's round runs the same gates, so the panel holds the INVALID and it settles by that result.
  appeal: {
    finding: { ...FINDING, title: 'Vault.deposit over-credits, a proof that edits the source, appealed' },
    poc: 'diff --git a/src/Vault.sol b/src/Vault.sol\n--- a/src/Vault.sol\n+++ b/src/Vault.sol\n@@ -11,5 +11,5 @@\n \n     function deposit(uint256 amount) external {\n-        balanceOf[msg.sender] += amount + 1;\n+        balanceOf[msg.sender] += amount + 3;\n     }\n }\n',
  },
  // Node P18, erratum E8: the valid claim's proof again, every gate passing; the jury's second juror scores it
  // all INVALID this time (JUROR_SEQUENCE), so the average is an INVALID with 50 points of valid mass: narrow.
  narrow: {
    finding: { ...FINDING, title: 'Vault.deposit over-credits, a second report of the same proof' },
    poc: null, // the valid claim's (claimFolder)
  },
  // Node P20: the valid claim's proof, checked by the hunter on the listing that names its documents.
  documents: {
    finding: { ...FINDING, title: 'Vault.deposit over-credits, on the listing that names its documents' },
    poc: null, // the valid claim's (claimFolder)
  },
  // A proof that never ends: the runner's clock stops it, and every arbiter abstains the same way.
  abstain: {
    finding: { ...FINDING, title: 'Vault.deposit over-credits, a proof that never ends', poc: { command: 'forge test --match-test test_never_ends', observable: 'test_never_ends fails at the committed hash with "2 != 1"' } },
    poc: addFile('test/Exploit.t.sol', `${POC_HEADER}contract ExploitTest is Base {\n    function test_never_ends() public {\n        uint256 i;\n        while (true) { i += 1; }\n    }\n}\n`),
  },
});

/** The hunter's folder for one of the claims: finding.json, report.md, poc.patch. */
export function claimFolder(workDir, name) {
  const claim = CLAIMS[name];
  const dir = path.join(workDir, `claim-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'finding.json'), `${JSON.stringify(claim.finding, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'report.md'), `# ${claim.finding.title}\n\n${REPORT_MARKER}\n`);
  fs.writeFileSync(path.join(dir, 'poc.patch'), claim.poc ?? CLAIMS.valid.poc);
  return dir;
}

/** Each juror's reply, weights 0.5 and 0.5, so only both together give the average the round asserts. */
export const JUROR_SCORES = Object.freeze([[0, 0, 0, 0, 800000, 200000], [0, 0, 0, 0, 600000, 400000]]);
export const JURY_AVERAGE = Object.freeze([0n, 0n, 0n, 0n, 700000n, 300000n]);
/**
 * Node P18, erratum E8. The claim panel's second juror answers JUROR_SCORES[1] for the valid claim's K jobs, and
 * then NARROW_SCORES: with the first juror's [0, 0, 0, 0, 800000, 200000] the narrow claim's average is
 * NARROW_AVERAGE, an INVALID (no class reaches THRESHOLD, and INVALID outweighs DUPLICATE) with 500,000 of valid
 * mass, inside the band of the round's floor (NARROW_FLOOR, 25 points) up to THRESHOLD - 1: its bond comes back.
 * No other claim of the round reaches the claim panel's jury: the gates settle the others, or they abstain.
 */
export const NARROW_SCORES = Object.freeze([1000000, 0, 0, 0, 0, 0]);
export const NARROW_AVERAGE = Object.freeze([500000n, 0n, 0n, 0n, 400000n, 100000n]);
export const NARROW_FLOOR = 250000n;
/** Node P18, erratum E9: awards above MEDIUM's wait for the dispute panel's confirmation, so the valid HIGH does. */
export const CONFIRM_ABOVE_WEI = AWARDS_WEI.MEDIUM;
export const JUSTIFIER = Object.freeze({ provider: 'openai', model: 'mock-justifier' });
