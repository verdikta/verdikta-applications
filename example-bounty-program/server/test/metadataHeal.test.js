/**
 * Titles for bounties discovered on-chain (sync service).
 *
 * addJobFromBlockchain reads the title from the evaluation package once, when
 * the bounty is discovered. Mainnet bounties 137/138 kept "Bounty #N" because
 * the gateways failed at that moment and nothing retried. These cover the
 * package read (fetchEvaluationMetadata) and the Phase D.6b retry
 * (needsMetadataHeal / healJobMetadata / applyEvaluationMetadata).
 */
const AdmZip = require('adm-zip');
const {
  fetchEvaluationMetadata,
  needsMetadataHeal,
  healJobMetadata,
  applyEvaluationMetadata,
} = require('../utils/syncService');

const CONTRACT = '0xa741eff41bcf14793e61cebb4179e05c9124d3f6';
const EVAL_CID = 'QmEvaluationPackageForMetadataHealTests000000000';
const RUBRIC_CID = 'QmGradingRubricForMetadataHealTests0000000000000';
const NOW = 1_800_000_000;

function zipOf(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, 'utf8'));
  return zip.toBuffer();
}

function evaluationPackage({ name, query = 'Evaluate the work.', withRubric = true } = {}) {
  return zipOf({
    'manifest.json': JSON.stringify({
      version: '1.0',
      ...(name ? { name } : {}),
      primary: { filename: 'primary_query.json' },
      juryParameters: { AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-5.2-2025-12-11', NO_COUNTS: 1, WEIGHT: 1 }] },
      additional: withRubric ? [{ name: 'gradingRubric', type: 'ipfs/cid', hash: RUBRIC_CID }] : [],
    }),
    'primary_query.json': JSON.stringify({ query, references: ['gradingRubric'], outcomes: ['DONT_FUND', 'FUND'] }),
  });
}

const RUBRIC = Buffer.from(JSON.stringify({
  title: 'Music Puzzle: The enharmonic trick',
  description: 'Identify the enharmonic respelling.',
  criteria: [],
}));

/** global.fetch stub: cid -> Buffer | 'html' | number (HTTP status) | Error; per-call overrides via a queue. */
function serve(files) {
  const calls = [];
  global.fetch = jest.fn(async (url, opts) => {
    calls.push({ url, opts });
    const cid = url.split('/ipfs/')[1];
    let entry = files[cid];
    if (Array.isArray(entry)) entry = entry.length > 1 ? entry.shift() : entry[0];
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'number') return new Response('error', { status: entry });
    if (entry === 'html') return new Response('<html>rate limited</html>', { status: 200 });
    if (!entry) return new Response('not found', { status: 404 });
    return new Response(entry);
  });
  return calls;
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('fetchEvaluationMetadata', () => {
  it('takes the title from manifest.name, trimming the " - Evaluation" suffix', async () => {
    serve({ [EVAL_CID]: evaluationPackage({ name: 'Music Puzzle: Time signature detective - Evaluation' }) });
    const m = await fetchEvaluationMetadata(EVAL_CID);
    expect(m.title).toBe('Music Puzzle: Time signature detective');
    expect(m.juryNodes).toEqual([{ provider: 'OpenAI', model: 'gpt-5.2-2025-12-11', runs: 1, weight: 1 }]);
  });

  it('passes an abort signal, so a hanging gateway times out', async () => {
    const calls = serve({ [EVAL_CID]: evaluationPackage({ name: 'T - Evaluation' }) });
    await fetchEvaluationMetadata(EVAL_CID);
    expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to the grading rubric title when the manifest has no name', async () => {
    serve({ [EVAL_CID]: evaluationPackage(), [RUBRIC_CID]: RUBRIC });
    const m = await fetchEvaluationMetadata(EVAL_CID);
    expect(m.title).toBe('Music Puzzle: The enharmonic trick');
    expect(m.description).toBe('Identify the enharmonic respelling.');
    expect(m.incomplete).toBeUndefined();
  });

  it('fills a missing description from the rubric without replacing the manifest title', async () => {
    serve({ [EVAL_CID]: evaluationPackage({ name: 'Manifest title - Evaluation' }), [RUBRIC_CID]: RUBRIC });
    const m = await fetchEvaluationMetadata(EVAL_CID);
    expect(m.title).toBe('Manifest title');
    expect(m.description).toBe('Identify the enharmonic respelling.');
  });

  it('is not incomplete when only the description source (rubric) failed', async () => {
    serve({ [EVAL_CID]: evaluationPackage({ name: 'Manifest title - Evaluation' }), [RUBRIC_CID]: 429 });
    const m = await fetchEvaluationMetadata(EVAL_CID);
    expect(m.title).toBe('Manifest title');
    expect(m.incomplete).toBeUndefined();
  });

  it('marks the result incomplete when the title could only come from a rubric that failed to fetch', async () => {
    serve({ [EVAL_CID]: evaluationPackage(), [RUBRIC_CID]: 429 });
    const m = await fetchEvaluationMetadata(EVAL_CID);
    expect(m.title).toBeNull();
    expect(m.incomplete).toBe(true);
  });

  it('skips a gateway that answers with an error page instead of the package', async () => {
    serve({ [EVAL_CID]: ['html', evaluationPackage({ name: 'Real title - Evaluation' })] });
    expect((await fetchEvaluationMetadata(EVAL_CID)).title).toBe('Real title');
  });

  it('returns null when no gateway delivers the package', async () => {
    serve({ [EVAL_CID]: 429 });
    expect(await fetchEvaluationMetadata(EVAL_CID)).toBeNull();
  });

  it('returns an empty result (not null) for a package that carries no metadata', async () => {
    serve({ [EVAL_CID]: evaluationPackage({ withRubric: false }) });
    const m = await fetchEvaluationMetadata(EVAL_CID);
    expect(m).not.toBeNull();
    expect(m.title).toBeNull();
  });
});

function syncedJob(overrides = {}) {
  return {
    jobId: 138,
    title: 'Bounty #138',
    description: 'Fetched from blockchain',
    workProductType: 'Work Product',
    juryNodes: [],
    evaluationCid: EVAL_CID,
    contractAddress: CONTRACT.toUpperCase(),
    syncedFromBlockchain: true,
    status: 'OPEN',
    ...overrides,
  };
}

describe('needsMetadataHeal', () => {
  it('selects a synced job still carrying the placeholder title', () => {
    expect(needsMetadataHeal(syncedJob(), CONTRACT, NOW)).toBe(true);
  });

  it('selects a job with a real title but the placeholder description', () => {
    expect(needsMetadataHeal(syncedJob({ title: 'Music Puzzle' }), CONTRACT, NOW)).toBe(true);
  });

  it('skips jobs with real metadata, on another contract, orphaned, or already healed', () => {
    expect(needsMetadataHeal(syncedJob({ title: 'Music Puzzle', description: 'Real description' }), CONTRACT, NOW)).toBe(false);
    expect(needsMetadataHeal(syncedJob({ contractAddress: '0x' + '2'.repeat(40) }), CONTRACT, NOW)).toBe(false);
    expect(needsMetadataHeal(syncedJob({ status: 'ORPHANED' }), CONTRACT, NOW)).toBe(false);
    expect(needsMetadataHeal(syncedJob({ _metadataHealDone: true }), CONTRACT, NOW)).toBe(false);
    expect(needsMetadataHeal(syncedJob({ syncedFromBlockchain: false }), CONTRACT, NOW)).toBe(false);
  });

  it('waits out the backoff and stops after the retry budget', () => {
    expect(needsMetadataHeal(syncedJob({ _metadataHealNextAt: NOW + 60 }), CONTRACT, NOW)).toBe(false);
    expect(needsMetadataHeal(syncedJob({ _metadataHealNextAt: NOW - 1 }), CONTRACT, NOW)).toBe(true);
    expect(needsMetadataHeal(syncedJob({ _metadataHealAttempts: 8 }), CONTRACT, NOW)).toBe(false);
  });
});

describe('healJobMetadata', () => {
  it('uses a rubric the API already stored on the job, without fetching', async () => {
    const fetchMetadata = jest.fn();
    const job = syncedJob({ rubricContent: { title: 'Music Puzzle: The enharmonic trick', description: 'Identify it.' } });
    expect(await healJobMetadata(job, NOW, fetchMetadata)).toBe('healed');
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(job.title).toBe('Music Puzzle: The enharmonic trick');
    expect(job.description).toBe('Identify it.');
    expect(job._metadataHealDone).toBe(true);
  });

  it('applies the package metadata when the fetch succeeds', async () => {
    const job = syncedJob();
    const outcome = await healJobMetadata(job, NOW, async () => ({
      title: 'Music Puzzle: Time signature detective', description: null, workProductType: null,
      juryNodes: [{ provider: 'OpenAI', model: 'gpt-5.2-2025-12-11', runs: 1, weight: 1 }],
    }));
    expect(outcome).toBe('healed');
    expect(job.title).toBe('Music Puzzle: Time signature detective');
    expect(job.description).toBe('Fetched from blockchain'); // nothing better was available
    expect(job.juryNodes).toHaveLength(1);
    expect(job._metadataHealDone).toBe(true);
  });

  it('schedules a retry with doubling backoff when the package is unavailable', async () => {
    const job = syncedJob();
    expect(await healJobMetadata(job, NOW, async () => null)).toBe('retry');
    expect(job._metadataHealAttempts).toBe(1);
    expect(job._metadataHealNextAt).toBe(NOW + 5 * 60);
    expect(job.title).toBe('Bounty #138');

    expect(await healJobMetadata(job, NOW, async () => ({ title: null, incomplete: true }))).toBe('retry');
    expect(job._metadataHealAttempts).toBe(2);
    expect(job._metadataHealNextAt).toBe(NOW + 10 * 60);
    expect(job._metadataHealDone).toBeUndefined();
  });

  it('fetches the package when the stored rubric has a title but no description', async () => {
    const job = syncedJob({ rubricContent: { title: 'Stored title' } });
    const fetchMetadata = jest.fn(async () => ({ title: 'Stored title', description: 'From the package', juryNodes: [] }));
    expect(await healJobMetadata(job, NOW, fetchMetadata)).toBe('healed');
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(job).toMatchObject({ title: 'Stored title', description: 'From the package', _metadataHealDone: true });
  });

  it('stops retrying once a readable package turns out to have no title', async () => {
    const job = syncedJob();
    expect(await healJobMetadata(job, NOW, async () => ({ title: null, description: null, juryNodes: [] }))).toBe('no-title');
    expect(job._metadataHealDone).toBe(true);
    expect(job.title).toBe('Bounty #138');
  });
});

describe('applyEvaluationMetadata', () => {
  it('never overwrites values that did not come from the sync defaults', () => {
    const job = syncedJob({ title: 'Creator title', description: 'Creator description', workProductType: 'Code', juryNodes: [{ model: 'x' }] });
    const changed = applyEvaluationMetadata(job, { title: 'Other', description: 'Other', workProductType: 'Essay', juryNodes: [{ model: 'y' }] });
    expect(changed).toBe(false);
    expect(job).toMatchObject({ title: 'Creator title', description: 'Creator description', workProductType: 'Code', juryNodes: [{ model: 'x' }] });
  });
});
