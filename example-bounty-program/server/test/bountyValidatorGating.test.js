/**
 * bountyValidator pieces the submission gate (issue #39) relies on:
 *  - QUERY_TOO_LONG (issue #36): an over-cap primary query is an ERROR;
 *  - a fetched-but-unparseable rubric is INVALID_RUBRIC, while a rubric that could
 *    not be fetched is RUBRIC_FETCH_FAILED (they used to share one type);
 *  - which issue types are deterministic (gating) and which are fetch failures.
 */
const AdmZip = require('adm-zip');
const {
  validateBounty,
  IssueType,
  IssueSeverity,
  GATING_ISSUE_TYPES,
  TRANSIENT_ISSUE_TYPES,
  isGatingIssue,
  isTransientIssue,
  maxEvaluationQueryChars,
  DEFAULT_MAX_EVALUATION_QUERY_CHARS,
} = require('../utils/bountyValidator');

const RUBRIC_CID = 'QmRubric';
const GOOD_RUBRIC = Buffer.from(JSON.stringify({ criteria: [{ id: 'a', label: 'A', weight: 1, must: false }] }));

function packageWith(query) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    version: '1.0',
    primary: { filename: 'primary_query.json' },
    juryParameters: { AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-5.6-sol', NO_COUNTS: 1, WEIGHT: 1 }] },
    additional: [{ name: 'gradingRubric', hash: RUBRIC_CID }],
    bCIDs: { submission: 'QmSubmission' },
  })));
  zip.addFile('primary_query.json', Buffer.from(JSON.stringify({ query, references: ['gradingRubric'], outcomes: ['DONT_FUND', 'FUND'] })));
  return zip.toBuffer();
}

const validate = (query, rubric = GOOD_RUBRIC) => validateBounty({
  evaluationCid: 'QmEval',
  classId: 128,
  ipfsClient: { fetchFromIPFS: async (cid) => (cid === RUBRIC_CID ? rubric : packageWith(query)) },
});
const types = (r) => r.issues.map((i) => i.type);

describe('QUERY_TOO_LONG', () => {
  afterEach(() => { delete process.env.MAX_EVALUATION_QUERY_CHARS; });

  it('accepts a query of exactly the cap and rejects one character more', async () => {
    expect(DEFAULT_MAX_EVALUATION_QUERY_CHARS).toBe(10000);
    expect(types(await validate('x'.repeat(10000)))).not.toContain(IssueType.QUERY_TOO_LONG);

    const over = await validate('x'.repeat(10001));
    expect(over.valid).toBe(false);
    const issue = over.issues.find((i) => i.type === IssueType.QUERY_TOO_LONG);
    expect(issue.severity).toBe(IssueSeverity.ERROR);
    expect(issue.message).toContain('10001 characters');
  });

  it('measures String.length (UTF-16 code units), the way the arbiters do', async () => {
    // 5,001 emoji are 10,002 UTF-16 code units but only 5,001 code points.
    const emoji = String.fromCodePoint(0x1f600).repeat(5001);
    expect(emoji.length).toBe(10002);
    expect(types(await validate(emoji))).toContain(IssueType.QUERY_TOO_LONG);
  });

  it('honours MAX_EVALUATION_QUERY_CHARS, ignoring a non-positive or non-numeric value', async () => {
    process.env.MAX_EVALUATION_QUERY_CHARS = '32000';
    expect(maxEvaluationQueryChars()).toBe(32000);
    expect(types(await validate('x'.repeat(12017)))).not.toContain(IssueType.QUERY_TOO_LONG);

    process.env.MAX_EVALUATION_QUERY_CHARS = '0';
    expect(maxEvaluationQueryChars()).toBe(10000);
    process.env.MAX_EVALUATION_QUERY_CHARS = 'lots';
    expect(maxEvaluationQueryChars()).toBe(10000);
  });
});

describe('rubric: a failed fetch and an unparseable rubric are different problems', () => {
  it('an unparseable rubric is INVALID_RUBRIC (deterministic)', async () => {
    const r = await validate('q'.repeat(50), Buffer.from('not json'));
    expect(types(r)).toContain(IssueType.INVALID_RUBRIC);
    expect(types(r)).not.toContain(IssueType.RUBRIC_FETCH_FAILED);
  });

  it('a rubric that cannot be fetched is RUBRIC_FETCH_FAILED (transient), not MISSING_RUBRIC', async () => {
    const r = await validateBounty({
      evaluationCid: 'QmEval',
      classId: 128,
      ipfsClient: { fetchFromIPFS: async (cid) => { if (cid === RUBRIC_CID) throw new Error('HTTP 429'); return packageWith('q'.repeat(50)); } },
    });
    expect(types(r)).toContain(IssueType.RUBRIC_FETCH_FAILED);
    expect(types(r)).not.toContain(IssueType.MISSING_RUBRIC);
  });
});

describe('which ERROR issues are deterministic', () => {
  const error = (type) => ({ type, severity: IssueSeverity.ERROR, message: 'm' });

  it('gates only on errors that depend on the package bytes', () => {
    for (const t of [IssueType.INVALID_FORMAT, IssueType.MISSING_RUBRIC, IssueType.INVALID_RUBRIC, IssueType.INVALID_PRIMARY_QUERY, IssueType.QUERY_TOO_LONG]) {
      expect(GATING_ISSUE_TYPES.has(t)).toBe(true);
      expect(isGatingIssue(error(t))).toBe(true);
    }
  });

  it('never gates on fetch failures, the class registry, or on-chain state', () => {
    for (const t of [IssueType.CID_INACCESSIBLE, IssueType.RUBRIC_FETCH_FAILED, IssueType.INVALID_CLASS, IssueType.MODEL_UNAVAILABLE, IssueType.CHAIN_STATUS, IssueType.NOT_ON_CHAIN]) {
      expect(isGatingIssue(error(t))).toBe(false);
    }
  });

  it('a warning of a gating type does not gate', () => {
    expect(isGatingIssue({ type: IssueType.INVALID_RUBRIC, severity: IssueSeverity.WARNING, message: 'm' })).toBe(false);
  });

  it('flags exactly the fetch failures as transient', () => {
    expect([...TRANSIENT_ISSUE_TYPES].sort()).toEqual([IssueType.CID_INACCESSIBLE, IssueType.RUBRIC_FETCH_FAILED].sort());
    expect(isTransientIssue(error(IssueType.CID_INACCESSIBLE))).toBe(true);
    expect(isTransientIssue(error(IssueType.INVALID_RUBRIC))).toBe(false);
    expect(isTransientIssue(null)).toBe(false);
  });
});
