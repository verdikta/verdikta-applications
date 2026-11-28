/**
 * Review 2026-11-28, blocker 4: a bounty says how many values each juror answers with (outcomes, 2
 * or 1). The Jumbo class uses one number; its evaluation package must ask for one, and the escrow
 * reads a result of any other length as no result.
 */
const archiveGenerator = require('../utils/archiveGenerator');
const { CLASS_PRESETS, toBountyParams } = require('../../shared/classPresets');

const CID = 'Qm' + 'a'.repeat(44);
const criteria = [
  { id: 'gate', must: true, instructions: 'It compiles.' },
  { id: 'quality', must: false, weight: 1, instructions: 'It is clear.' },
];

describe('one-number bounties', () => {
  it('the presets: Jumbo answers with one number, the other classes with two', () => {
    expect(Object.fromEntries(CLASS_PRESETS.map((c) => [c.key, c.outcomes])))
      .toEqual({ 'bondless-small': 2, small: 2, medium: 2, large: 2, jumbo: 1 });
    expect(toBountyParams('jumbo', 2000).outcomes).toBe(1);
    expect(toBountyParams('large', 2000).outcomes).toBe(2);
    expect(toBountyParams('large', 2000, { outcomes: 1 }).outcomes).toBe(1);   // the creator's choice
  });

  it('a one-number package asks for FUND alone and never names DONT_FUND in its protocol text', () => {
    const { manifest, primaryQuery } = archiveGenerator.evaluationPackageFiles({
      rubricCid: CID, jobTitle: 'T', jobDescription: 'D', rubricCriteria: criteria, forbiddenContent: ['spam'], outcomes: 1,
    });
    expect(primaryQuery.outcomes).toEqual(['FUND']);
    expect(manifest.juryParameters.NUMBER_OF_OUTCOMES).toBe(1);
    expect(primaryQuery.query).not.toMatch(/DONT_FUND/);
    expect(primaryQuery.query).toMatch(/Provide ONE score, FUND/);
    expect(primaryQuery.query).toMatch(/FINAL SCORE: FUND=XX\.X/);
    expect(primaryQuery.query).toMatch(/-> FUND = 0/);                        // the must-pass override
    expect(archiveGenerator.oneOutcomeTemplateIsClean()).toBe(true);           // every variant of the template
  });

  it('the default is the two-outcome package, unchanged', () => {
    const two = archiveGenerator.evaluationPackageFiles({ rubricCid: CID, jobTitle: 'T', jobDescription: 'D', rubricCriteria: criteria });
    expect(two.primaryQuery.outcomes).toEqual(['DONT_FUND', 'FUND']);
    expect(two.manifest.juryParameters.NUMBER_OF_OUTCOMES).toBe(2);
    expect(two.primaryQuery.query).toMatch(/Provide scores for two outcomes/);
    expect(() => archiveGenerator.evaluationPackageFiles({ rubricCid: CID, jobTitle: 'T', jobDescription: 'D', outcomes: 3 })).toThrow(/outcomes must be 1 or 2/);
  });

  it('the creator\'s own text may say DONT_FUND: only the protocol text is rewritten', () => {
    const { primaryQuery } = archiveGenerator.evaluationPackageFiles({
      rubricCid: CID, jobTitle: 'About DONT_FUND', jobDescription: 'Explain the word DONT_FUND.', rubricCriteria: criteria, outcomes: 1,
    });
    expect(primaryQuery.query).toMatch(/Task Title: About DONT_FUND/);
  });
});
