/**
 * The create-time rubric check (utils/validation) and the post-creation package
 * check (utils/bountyValidator, which gates submissions) apply the same weight
 * rule: scored criteria must sum to 1.0, and a rubric of only must-pass criteria
 * has nothing to sum. Testnet bounties 14/15 were accepted at create and then
 * gated, because the second check had no must-pass-only exception.
 */
const AdmZip = require('adm-zip');
const { validateRubric } = require('../utils/validation');
const { validateBounty, IssueType } = require('../utils/bountyValidator');

const c = (id, must, weight) => ({ id, label: id, must, weight, description: `criterion ${id}` });
const CASES = [
  ['only must-pass criteria', [c('a', true, 0), c('b', true, 0)], true],
  ['must-pass plus scored summing to 1.0', [c('a', true, 0), c('b', false, 0.4), c('c', false, 0.6)], true],
  ['scored criteria summing to 0.4', [c('a', true, 0), c('b', false, 0.4)], false],
  ['scored criteria all weighted 0', [c('a', false, 0), c('b', false, 0)], false],
];

function packageFor() {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    version: '1.0',
    primary: { filename: 'primary_query.json' },
    juryParameters: { AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-5.6-sol', NO_COUNTS: 1, WEIGHT: 1 }] },
    additional: [{ name: 'gradingRubric', hash: 'QmRubric' }],
    bCIDs: { submission: 'QmSubmission' },
  })));
  zip.addFile('primary_query.json', Buffer.from(JSON.stringify({ query: 'q'.repeat(50), references: ['gradingRubric'], outcomes: ['DONT_FUND', 'FUND'] })));
  return zip.toBuffer();
}

describe.each(CASES)('%s', (_name, criteria, valid) => {
  it(`is ${valid ? 'accepted' : 'rejected'} at create`, () => {
    expect(validateRubric({ criteria }).valid).toBe(valid);
  });

  it(`is ${valid ? 'not gated' : 'gated'} after creation`, async () => {
    const r = await validateBounty({
      evaluationCid: 'QmEval',
      classId: 128,
      ipfsClient: { fetchFromIPFS: async (cid) => (cid === 'QmRubric' ? Buffer.from(JSON.stringify({ criteria })) : packageFor()) },
    });
    const weightError = r.issues.some((i) => i.type === IssueType.INVALID_RUBRIC && /must sum to 1.0/.test(i.message));
    expect(weightError).toBe(!valid);
  });
});
