/**
 * Tests for buildEvaluationQuery — the two-phase evaluation protocol
 * Run with: npx jest test/queryBuilder.test.js
 *       or: node server/test/queryBuilder.test.js
 */

const { buildEvaluationQuery } = require('../utils/archiveGenerator');

const baseParams = {
  workProductType: 'Blog Post',
  jobTitle: 'Write a Solidity Tutorial',
  jobDescription: 'Write a beginner-friendly blog post about Solidity smart contracts.'
};

// ---------------------------------------------------------------------------
// Scenario 1: Must-pass + weighted criteria
// ---------------------------------------------------------------------------

const scenario1Query = buildEvaluationQuery({
  ...baseParams,
  rubricCriteria: [
    { id: 'safety', label: 'Content Safety', must: true, weight: 0.0, instructions: 'Reject if NSFW or hate speech.' },
    { id: 'originality', label: 'Originality', must: true, weight: 0.0, instructions: 'Reject if plagiarized.' },
    { id: 'accuracy', label: 'Technical Accuracy', must: false, weight: 0.40, instructions: 'Correct technical information.' },
    { id: 'quality', label: 'Overall Quality', must: false, weight: 0.60, instructions: 'Well-written and useful.' }
  ],
  forbiddenContent: ['NSFW content', 'Hate speech', 'Plagiarism']
});

describe('Scenario 1: Must-pass + weighted criteria', () => {
  test('contains two-phase protocol header', () => {
    expect(scenario1Query).toContain('two-phase evaluation process');
  });

  test('Phase 1 lists must-pass criteria by name', () => {
    expect(scenario1Query).toContain('Content Safety');
    expect(scenario1Query).toContain('Originality');
  });

  test('Phase 1 includes must-pass instructions', () => {
    expect(scenario1Query).toContain('Reject if NSFW or hate speech');
    expect(scenario1Query).toContain('Reject if plagiarized');
  });

  test('Phase 1 has critical scoring rule', () => {
    expect(scenario1Query).toContain('DONT_FUND = 100, FUND = 0');
  });

  test('Phase 1 requires explicit PASS/FAIL', () => {
    expect(scenario1Query).toContain('PASS or FAIL');
  });

  test('forbidden content is surfaced', () => {
    expect(scenario1Query).toContain('NSFW content');
    expect(scenario1Query).toContain('Hate speech');
  });

  test('Phase 2 lists weighted criteria with weights', () => {
    expect(scenario1Query).toContain('Technical Accuracy (weight: 0.40)');
    expect(scenario1Query).toContain('Overall Quality (weight: 0.60)');
  });

  test('Phase 2 is gated on Phase 1', () => {
    expect(scenario1Query).toContain('ONLY reach this phase if ALL mandatory criteria');
  });

  test('scoring rules include must-pass override', () => {
    expect(scenario1Query).toContain('Must-Pass Override');
    expect(scenario1Query).toContain('No exceptions');
  });

  test('justification format includes both phases', () => {
    expect(scenario1Query).toContain('PHASE 1 - MANDATORY REQUIREMENTS');
    expect(scenario1Query).toContain('PHASE 2 - QUALITY ASSESSMENT');
    expect(scenario1Query).toContain('MANDATORY REQUIREMENT FAILED');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Weighted criteria only (no must-pass)
// ---------------------------------------------------------------------------

const scenario2Query = buildEvaluationQuery({
  ...baseParams,
  rubricCriteria: [
    { id: 'accuracy', label: 'Technical Accuracy', must: false, weight: 0.50, instructions: 'Correct information.' },
    { id: 'quality', label: 'Overall Quality', must: false, weight: 0.50, instructions: 'Well-written.' }
  ]
});

describe('Scenario 2: Weighted criteria only', () => {
  test('does NOT contain Phase 1 or must-pass language', () => {
    expect(scenario2Query).not.toContain('PHASE 1');
    expect(scenario2Query).not.toContain('MANDATORY REQUIREMENTS');
    expect(scenario2Query).not.toContain('Must-Pass Override');
  });

  test('contains weighted criteria section', () => {
    expect(scenario2Query).toContain('QUALITY ASSESSMENT');
    expect(scenario2Query).toContain('Technical Accuracy (weight: 0.50)');
  });

  test('contains scoring rules for weighted only', () => {
    expect(scenario2Query).toContain('Weighted Scoring');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Must-pass criteria only (no weighted)
// ---------------------------------------------------------------------------

const scenario3Query = buildEvaluationQuery({
  ...baseParams,
  rubricCriteria: [
    { id: 'safety', label: 'Content Safety', must: true, weight: 0.0, instructions: 'No harmful content.' },
    { id: 'originality', label: 'Original Work', must: true, weight: 0.0, instructions: 'Not plagiarized.' }
  ]
});

describe('Scenario 3: Must-pass criteria only', () => {
  test('contains Phase 1 must-pass criteria', () => {
    expect(scenario3Query).toContain('Content Safety');
    expect(scenario3Query).toContain('Original Work');
  });

  test('does NOT contain Phase 2 or weighted language', () => {
    expect(scenario3Query).not.toContain('PHASE 2');
    expect(scenario3Query).not.toContain('Weighted Scoring');
  });

  test('instructs FUND=100 when all pass', () => {
    expect(scenario3Query).toContain('FUND = 100');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: No criteria (fallback)
// ---------------------------------------------------------------------------

const scenario4Query = buildEvaluationQuery({ ...baseParams });

describe('Scenario 4: No criteria (fallback)', () => {
  test('uses fallback query', () => {
    expect(scenario4Query).toContain('impartial evaluator');
  });

  test('fallback still mentions must:true semantics', () => {
    expect(scenario4Query).toContain('"must": true');
    expect(scenario4Query).toContain('DONT_FUND=100, FUND=0');
  });
});

// ---------------------------------------------------------------------------
// FUND is the weighted average (2026-10-18). Before, the rule said only "higher
// weighted averages -> higher FUND"; models scored their confidence of clearing a
// pass mark named in the description (mainnet bounties 242/243 recorded 17% / 26%).
// ---------------------------------------------------------------------------

describe('Weighted scoring sets FUND to the weighted average', () => {
  const withThreshold = buildEvaluationQuery({
    ...baseParams,
    jobDescription: 'Write a Solidity tutorial. Submissions must score at least 80% to be paid.',
    rubricCriteria: [
      { id: 'safety', label: 'Content Safety', must: true, weight: 0.0, instructions: 'Reject if NSFW.' },
      { id: 'accuracy', label: 'Technical Accuracy', must: false, weight: 0.4, instructions: 'Correct.' },
      { id: 'quality', label: 'Overall Quality', must: false, weight: 0.6, instructions: 'Useful.' }
    ]
  });
  const RULE_LINES = [
    'Set FUND to that weighted average, to one decimal place (for example 72.4). Do not round it to a whole number and do not adjust it for any other reason.',
    'Set DONT_FUND = 100 - FUND.',
    'FUND is a quality score on a 0-100 scale. It is NOT a probability, and NOT your confidence that the work will pass.',
    'Ignore any pass mark or threshold mentioned in the task description: the escrow contract compares FUND to the bounty threshold itself.',
  ];

  test.each([
    ['must-pass + weighted', withThreshold],
    ['weighted only', scenario2Query],
    ['no-rubric fallback', scenario4Query],
  ])('%s: states the exact FUND rule', (_name, query) => {
    for (const line of RULE_LINES) expect(query).toContain(line);
    expect(query).not.toContain('Higher weighted averages');
  });

  test('the must-pass override still comes first and wins', () => {
    const override = withThreshold.indexOf('Rule 1 - Must-Pass Override');
    const weightedRule = withThreshold.indexOf('Rule 2 - Weighted Scoring (only when ALL mandatory criteria pass)');
    expect(override).toBeGreaterThan(-1);
    expect(weightedRule).toBeGreaterThan(override);
    expect(withThreshold).toContain('-> DONT_FUND = 100, FUND = 0');
  });

  test('the justification asks for one-decimal weighted average and scores', () => {
    expect(withThreshold).toContain('- Weighted Average: XX.X/100');
    expect(withThreshold).toContain('FINAL SCORES: DONT_FUND=XX.X, FUND=XX.X');
  });

  test('must-pass-only bounties keep whole-number scores (FUND is 0 or 100)', () => {
    expect(scenario3Query).toContain('FINAL SCORES: DONT_FUND=XX, FUND=XX');
    expect(scenario3Query).not.toContain('Set FUND to that weighted average');
  });

  test('the fallback keeps the no-weighted-criteria case at FUND=100', () => {
    expect(scenario4Query).toContain('If the rubric has no weighted criteria, score FUND=100, DONT_FUND=0.');
  });

  test('the closing line the oracle requires is still last', () => {
    for (const q of [withThreshold, scenario2Query, scenario3Query, scenario4Query]) {
      expect(q.trimEnd().endsWith('The submitted work product will be provided in the next section.')).toBe(true);
    }
  });
});
