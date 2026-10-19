/**
 * Reading a bounty's description back out of its evaluation package.
 *
 * Bounties with no /jobs/create record of their own get their description from
 * the package (chain sync). The sync used to stop at the first blank line or
 * "===", so mainnet #299 (a re-funded mutual-wager package) kept only its first
 * sentence and jurors checking its terms against /api/jobs/299 failed every
 * claim. These pin the shared reader (utils/taskDescription.js) and both of its
 * users: fetchEvaluationMetadata (sync) and GET /jobs/:id/task-spec.
 */

let mockStorageData = { jobs: [], nextId: 0 };

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(mockStorageData))),
      writeFile: jest.fn().mockImplementation((_path, data) => {
        mockStorageData = JSON.parse(data);
        return Promise.resolve();
      }),
      rename: jest.fn().mockResolvedValue(undefined),
    },
  };
});

jest.mock('../config', () => ({
  config: {
    network: 'base-sepolia',
    bountyEscrowAddress: '0xabc123',
    chainId: 84532,
    explorer: 'https://sepolia.basescan.org',
    ipfsReadGateways: ['https://gateway.test'],
  },
}));

const express = require('express');
const request = require('supertest');
const AdmZip = require('adm-zip');
const { extractTaskDescription } = require('../utils/taskDescription');
const { buildEvaluationQuery } = require('../utils/archiveGenerator');
const { fetchEvaluationMetadata } = require('../utils/syncService');
const jobRoutes = require('../routes/jobRoutes');

const EVAL_CID = 'QmTaskDescriptionTestPackage00000000000000000000';

// The shape of a mutual-wager description: a lead sentence, a blank line, a
// "=== ... ===" terms block, then a trailing paragraph.
const WAGER_DESCRIPTION = [
  'Settles one side of a two-bounty wager.',
  '',
  '=== MUTUAL WAGER TERMS (mutual-wager-v1) ===',
  'Wager ID: VW-TEST-20261018',
  'Event: Team A at Team B, 2026-10-18T17:00:00Z.',
  'Poster (creator): 0x1111111111111111111111111111111111111111; side: Team B wins.',
  'Claimant (target, the only wallet that can claim): 0x2222222222222222222222222222222222222222; side: Team A wins.',
  'Pays the Claimant only if Team A wins.',
  'Settlement deadline: 2026-10-20T17:00:00Z',
  '=== END WAGER TERMS ===',
  '',
  'To claim: submit claim.md with the final score and two sources (URL + quote).',
].join('\n');

// Markdown with a setext heading ("=====" underline) and an inline "===".
const MARKDOWN_DESCRIPTION = [
  'Write a haiku about rivers.',
  '',
  'Requirements',
  '============',
  '- 5/7/5 syllables',
  '- passes if lines === 3',
  '',
  'No AI disclaimers.',
].join('\n');

const CRITERIA = [
  { id: 'terms_match', label: 'Terms match', must: true, instructions: 'Compare the === TERMS === block.' },
  { id: 'quality', label: 'Quality', must: false, weight: 1, instructions: 'Clear and sourced.' },
];

function queryFor(jobDescription, rubricCriteria = CRITERIA) {
  return buildEvaluationQuery({
    workProductType: 'Wager settlement claim',
    jobTitle: 'Wager VW-TEST-20261018',
    jobDescription,
    rubricCriteria,
  });
}

function evaluationPackage(query) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    version: '1.0',
    name: 'Wager VW-TEST-20261018 - Evaluation',
    primary: { filename: 'primary_query.json' },
    juryParameters: { AI_NODES: [] },
    additional: [],
  })));
  zip.addFile('primary_query.json', Buffer.from(JSON.stringify({ query, references: [], outcomes: ['DONT_FUND', 'FUND'] })));
  return zip.toBuffer();
}

describe('extractTaskDescription', () => {
  it('keeps blank lines and "===" lines up to the EVALUATION PROTOCOL section', () => {
    expect(extractTaskDescription(queryFor(WAGER_DESCRIPTION))).toBe(WAGER_DESCRIPTION);
    expect(extractTaskDescription(queryFor(MARKDOWN_DESCRIPTION))).toBe(MARKDOWN_DESCRIPTION);
  });

  it('ends at EVALUATION INSTRUCTIONS in the no-criteria fallback template', () => {
    const query = queryFor(WAGER_DESCRIPTION, []);
    expect(query).toContain('\n\n=== EVALUATION INSTRUCTIONS ===');
    expect(query).not.toContain('=== EVALUATION PROTOCOL ===');
    expect(extractTaskDescription(query)).toBe(WAGER_DESCRIPTION);
  });

  it('is what the pre-fix sync regex cut to its first sentence', () => {
    const query = queryFor(WAGER_DESCRIPTION);
    const old = query.match(/Task Description:\s*(.+?)(?:\n\n|===|$)/s)[1].trim();
    expect(old).toBe('Settles one side of a two-bounty wager.');
    expect(WAGER_DESCRIPTION.startsWith(old)).toBe(true);
  });

  it('reads a one-line description unchanged and trims surrounding whitespace', () => {
    expect(extractTaskDescription(queryFor('Fix the login bug.'))).toBe('Fix the login bug.');
    expect(extractTaskDescription(queryFor('  Fix the login bug.\n\n'))).toBe('Fix the login bug.');
  });

  it('falls back to the first paragraph when the query is not in the API template', () => {
    const query = 'Task Description: Summarise the paper.\n\nScore it 0-100 on accuracy.';
    expect(extractTaskDescription(query)).toBe('Summarise the paper.');
  });

  it('returns null without a "Task Description:" line, for an empty one, or for a non-string', () => {
    expect(extractTaskDescription('Evaluate the work.')).toBeNull();
    expect(extractTaskDescription(queryFor(''))).toBeNull();
    expect(extractTaskDescription(undefined)).toBeNull();
  });
});

describe('fetchEvaluationMetadata (chain sync)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('stores the whole description of a package whose description has blank lines and "===" lines', async () => {
    global.fetch = jest.fn(async (url) => (url.endsWith(`/ipfs/${EVAL_CID}`)
      ? new Response(evaluationPackage(queryFor(WAGER_DESCRIPTION)))
      : new Response('not found', { status: 404 })));
    const metadata = await fetchEvaluationMetadata(EVAL_CID);
    expect(metadata.title).toBe('Wager VW-TEST-20261018');
    expect(metadata.description).toBe(WAGER_DESCRIPTION);
    expect(metadata.workProductType).toBe('Wager settlement claim');
  });
});

describe('GET /jobs/:id/task-spec', () => {
  async function taskSpecFor(query) {
    mockStorageData = {
      jobs: [{ jobId: 0, title: 'Wager', status: 'OPEN', submissions: [], onChain: true, syncedFromBlockchain: true, evaluationCid: EVAL_CID }],
      nextId: 1,
    };
    const app = express();
    app.locals.ipfsClient = { fetchFromIPFS: jest.fn(async () => evaluationPackage(query)) };
    app.use('/jobs', jobRoutes);
    const res = await request(app).get('/jobs/0/task-spec');
    expect(res.status).toBe(200);
    return res.body.taskSpec;
  }

  it('returns the same full description the sync stores', async () => {
    expect(await taskSpecFor(queryFor(WAGER_DESCRIPTION))).toBe(WAGER_DESCRIPTION);
  });

  it('stops at EVALUATION INSTRUCTIONS in the no-criteria template instead of returning the scoring rules', async () => {
    expect(await taskSpecFor(queryFor(WAGER_DESCRIPTION, []))).toBe(WAGER_DESCRIPTION);
  });
});
