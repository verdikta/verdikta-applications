/**
 * Tests for buildEvaluationQuery — the two-phase evaluation protocol
 * Run with: node server/test/queryBuilder.test.js
 */

const { buildEvaluationQuery } = require('../utils/archiveGenerator');

const baseParams = {
  workProductType: 'Blog Post',
  jobTitle: 'Write a Solidity Tutorial',
  jobDescription: 'Write a beginner-friendly blog post about Solidity smart contracts.'
};

function runTest(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\n=== buildEvaluationQuery tests ===\n');

// ---- Scenario 1: Must-pass + weighted criteria ----
console.log('Scenario 1: Must-pass + weighted criteria');
{
  const query = buildEvaluationQuery({
    ...baseParams,
    rubricCriteria: [
      { id: 'safety', label: 'Content Safety', must: true, weight: 0.0, instructions: 'Reject if NSFW or hate speech.' },
      { id: 'originality', label: 'Originality', must: true, weight: 0.0, instructions: 'Reject if plagiarized.' },
      { id: 'accuracy', label: 'Technical Accuracy', must: false, weight: 0.40, instructions: 'Correct technical information.' },
      { id: 'quality', label: 'Overall Quality', must: false, weight: 0.60, instructions: 'Well-written and useful.' }
    ],
    forbiddenContent: ['NSFW content', 'Hate speech', 'Plagiarism']
  });

  runTest('contains two-phase protocol header', () => {
    assert(query.includes('two-phase evaluation process'), 'Missing two-phase header');
  });

  runTest('Phase 1 lists must-pass criteria by name', () => {
    assert(query.includes('Content Safety'), 'Missing Content Safety criterion');
    assert(query.includes('Originality'), 'Missing Originality criterion');
  });

  runTest('Phase 1 includes must-pass instructions', () => {
    assert(query.includes('Reject if NSFW or hate speech'), 'Missing safety instructions');
    assert(query.includes('Reject if plagiarized'), 'Missing originality instructions');
  });

  runTest('Phase 1 has critical scoring rule', () => {
    assert(query.includes('DONT_FUND = 100, FUND = 0'), 'Missing must-pass scoring rule');
  });

  runTest('Phase 1 requires explicit PASS/FAIL', () => {
    assert(query.includes('PASS or FAIL'), 'Missing PASS/FAIL requirement');
  });

  runTest('forbidden content is surfaced', () => {
    assert(query.includes('NSFW content'), 'Missing forbidden item');
    assert(query.includes('Hate speech'), 'Missing forbidden item');
  });

  runTest('Phase 2 lists weighted criteria with weights', () => {
    assert(query.includes('Technical Accuracy (weight: 0.40)'), 'Missing weighted criterion');
    assert(query.includes('Overall Quality (weight: 0.60)'), 'Missing weighted criterion');
  });

  runTest('Phase 2 is gated on Phase 1', () => {
    assert(query.includes('ONLY reach this phase if ALL mandatory criteria'), 'Missing Phase 2 gate');
  });

  runTest('scoring rules include must-pass override', () => {
    assert(query.includes('Must-Pass Override'), 'Missing Rule 1');
    assert(query.includes('No exceptions'), 'Missing absoluteness');
  });

  runTest('justification format includes both phases', () => {
    assert(query.includes('PHASE 1 - MANDATORY REQUIREMENTS'), 'Missing Phase 1 justification');
    assert(query.includes('PHASE 2 - QUALITY ASSESSMENT'), 'Missing Phase 2 justification');
    assert(query.includes('MANDATORY REQUIREMENT FAILED'), 'Missing failure stop instruction');
  });
}

// ---- Scenario 2: Weighted criteria only (no must-pass) ----
console.log('\nScenario 2: Weighted criteria only');
{
  const query = buildEvaluationQuery({
    ...baseParams,
    rubricCriteria: [
      { id: 'accuracy', label: 'Technical Accuracy', must: false, weight: 0.50, instructions: 'Correct information.' },
      { id: 'quality', label: 'Overall Quality', must: false, weight: 0.50, instructions: 'Well-written.' }
    ]
  });

  runTest('does NOT contain Phase 1 or must-pass language', () => {
    assert(!query.includes('PHASE 1'), 'Should not have Phase 1');
    assert(!query.includes('MANDATORY REQUIREMENTS'), 'Should not mention mandatory requirements');
    assert(!query.includes('Must-Pass Override'), 'Should not have must-pass rule');
  });

  runTest('contains weighted criteria section', () => {
    assert(query.includes('QUALITY ASSESSMENT'), 'Missing quality assessment section');
    assert(query.includes('Technical Accuracy (weight: 0.50)'), 'Missing weighted criterion');
  });

  runTest('contains scoring rules for weighted only', () => {
    assert(query.includes('Weighted Scoring'), 'Missing weighted scoring rule');
  });
}

// ---- Scenario 3: Must-pass criteria only (no weighted) ----
console.log('\nScenario 3: Must-pass criteria only');
{
  const query = buildEvaluationQuery({
    ...baseParams,
    rubricCriteria: [
      { id: 'safety', label: 'Content Safety', must: true, weight: 0.0, instructions: 'No harmful content.' },
      { id: 'originality', label: 'Original Work', must: true, weight: 0.0, instructions: 'Not plagiarized.' }
    ]
  });

  runTest('contains Phase 1 must-pass criteria', () => {
    assert(query.includes('Content Safety'), 'Missing criterion');
    assert(query.includes('Original Work'), 'Missing criterion');
  });

  runTest('does NOT contain Phase 2 or weighted language', () => {
    assert(!query.includes('PHASE 2'), 'Should not have Phase 2');
    assert(!query.includes('Weighted Scoring'), 'Should not mention weighted scoring');
  });

  runTest('instructs FUND=100 when all pass', () => {
    assert(query.includes('FUND = 100'), 'Missing all-pass instruction');
  });
}

// ---- Scenario 4: No criteria (fallback) ----
console.log('\nScenario 4: No criteria (fallback)');
{
  const query = buildEvaluationQuery({ ...baseParams });

  runTest('uses fallback query', () => {
    assert(query.includes('impartial evaluator'), 'Missing fallback content');
  });

  runTest('fallback still mentions must:true semantics', () => {
    assert(query.includes('"must": true'), 'Fallback should reference must:true');
    assert(query.includes('DONT_FUND=100, FUND=0'), 'Fallback should state must-pass rule');
  });
}

console.log('\n=== All tests complete ===\n');
