// A justification upload as an arbiter pins it (external-adapter README, "The justification"): JSON,
// with the Execution evidence block as the first thing in `justification`. The block and the text
// after it are what the real writer gives (buildRunnerVerdict, verdikta-arbiter at 3e8a86b), with the
// fields a test varies as arguments.
const CID_A = `bafkrei${'a'.repeat(52)}`;
const CID_B = `bafkrei${'b'.repeat(52)}`;

export function evidenceBlock({ settlement = 'DUPLICATE (integrity)', sha = 'f'.repeat(64), checks = 'frameworkUnchanged,dependenciesUnchanged', tamper = 'none' } = {}) {
  return [
    'Execution evidence v1',
    `Settlement: ${settlement}`,
    `Report-SHA256: ${sha}`,
    `Listing: ${CID_A}`,
    `Claim: ${CID_B}`,
    `Inputs: envImage=sha256:${'c'.repeat(64)} baseCommit=${'d'.repeat(40)} runner=1.0.0 gvisor=release-20260921.0 semgrepRules=sha256:${'e'.repeat(64)}`,
    'Gates-EA: disclosure=pass inScope=pass',
    'Gates-Tier-A: applies=pass testPathsOnly=pass build=pass integrity=fail',
    'Gates-Tier-B: reproduces=fail claimedObservable=notRun',
    'PoC-Runs: tests=1 fail=3 pass=0 error=0 skip=0 missing=0 duplicate=0 notRun=0',
    'PoC-Run-Pattern: #1 fail,fail,fail',
    `Integrity-Failed-Checks: ${checks}`,
    `Tamper-Flags: ${tamper}`,
    'Honesty-Flags: 0',
    'Findings: total=0 critical=0 high=0 medium=0 low=0 info=0',
    'Patch-Flags: existingTestsModified=0 skipMarkersAdded=0 protectedPathsTouched=0',
    'Diff-PoC: files=1 added=10 removed=0',
    'Diff-Fix: none',
    'Fix: present=false',
    'End execution evidence',
  ].join('\n');
}

const FIXED = '\n\nVerdict: DUPLICATE (deterministic, not an AI judgement). All weight goes on "DUPLICATE" because that outcome returns the bond with no award; it does not say the finding repeats another.\n\nThis states what the checks found. It does not say who or what caused it.';

/** The upload of a justification, as bytes. */
export const uploadBytes = (justification) => Buffer.from(JSON.stringify({
  scores: [],
  justification,
  timestamp: '2026-11-03T00:00:00Z',
  metadata: { verdict_source: 'code-review-integrity' },
}));

/** The upload of a claim that failed integrity, naming `checks`. */
export const integrityUpload = (o = {}) => uploadBytes(`${evidenceBlock(o)}${FIXED}`);
/** The upload of a jury's verdict, with `text` after its block. */
export const juryUpload = (text = 'The jurors say this repeats a known issue.') => uploadBytes(`${evidenceBlock({ settlement: 'jury', checks: 'none' })}\n\n${text}`);
