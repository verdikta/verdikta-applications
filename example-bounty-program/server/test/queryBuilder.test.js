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
