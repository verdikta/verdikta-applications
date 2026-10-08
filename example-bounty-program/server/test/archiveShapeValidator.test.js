/**
 * Tests for archiveShapeValidator — the shape-check that fixes #34.
 *
 * Covers the three real malformed archives from bounties 57, 58, 59 (fixture
 * copies built in-memory, NOT fetched from live IPFS — see the issue's
 * Validation section) plus the conforming bounty-60 shape.
 *
 * Run with: npx jest test/archiveShapeValidator.test.js
 */

const AdmZip = require('adm-zip');
const {
  validateArchiveShape,
  fetchAndValidateArchiveShape,
  archiveShapeLabel,
  CONFORMING_SHAPE_EXAMPLE,
  MAX_JSON_ENTRY_BYTES,
} = require('../utils/archiveShapeValidator');

function zipOf(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('validateArchiveShape', () => {
  // Bounty 59: primary file is markdown, arbiter JSON-parses it → fails.
  it('rejects a primary file that is not JSON (bounty 59 shape)', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify({
        version: '1.0',
        name: 'submittedWork',
        primary: { filename: 'submission.md' },
      }),
      'submission.md': '# My work\n\nHere is the thing I built.',
    });
    const result = validateArchiveShape(buf);
    expect(result.ok).toBe(false);
    expect(result.check).toBe('primary-not-json');
  });

  // Bounty 58: manifest has no `primary` field at all.
  it('rejects a manifest with no "primary" field (bounty 58 shape)', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify({
        version: '1.0',
        type: 'submission',
        files: ['work.md'],
      }),
      'work.md': 'some content',
    });
    const result = validateArchiveShape(buf);
    expect(result.ok).toBe(false);
    expect(result.check).toBe('primary-missing');
  });

  // Bounty 57: the markdown itself was pinned directly — not a ZIP at all.
  it('rejects raw non-ZIP content (bounty 57 shape)', () => {
    const buf = Buffer.from('# My work\n\nThis is markdown, not a ZIP archive.', 'utf8');
    const result = validateArchiveShape(buf);
    expect(result.ok).toBe(false);
    expect(result.check).toBe('not-a-zip');
  });

  // Bounty 60: went through /submit and passed 6/6 — the conforming shape.
  it('accepts the conforming shape (bounty 60 / CONFORMING_SHAPE_EXAMPLE)', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify(CONFORMING_SHAPE_EXAMPLE),
      'primary_query.json': JSON.stringify({
        query: 'This is my submitted work, please review it against the grading rubric provided.',
        references: ['content'],
      }),
      'submission.md': '# My work\n\nHere is the thing I built.',
    });
    const result = validateArchiveShape(buf);
    expect(result).toEqual({ ok: true });
  });

  it('accepts a manifest with no "name" field at all (absent is allowed)', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify({ version: '1.0', primary: { filename: 'primary_query.json' } }),
      'primary_query.json': JSON.stringify({ query: 'A valid query string of reasonable length.' }),
    });
    expect(validateArchiveShape(buf).ok).toBe(true);
  });

  it('rejects a manifest.json that is not valid JSON', () => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('{not valid json', 'utf8'));
    const result = validateArchiveShape(zip.toBuffer());
    expect(result.ok).toBe(false);
    expect(result.check).toBe('manifest-not-json');
  });

  it('rejects an archive with no manifest.json at all', () => {
    const buf = zipOf({ 'readme.txt': 'no manifest here' });
    const result = validateArchiveShape(buf);
    expect(result.ok).toBe(false);
    expect(result.check).toBe('manifest-missing');
  });

  it('rejects when manifest.json "name" is present but wrong', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify({ name: 'somethingElse', primary: { filename: 'primary_query.json' } }),
      'primary_query.json': JSON.stringify({ query: 'A valid query string of reasonable length.' }),
    });
    const result = validateArchiveShape(buf);
    expect(result.ok).toBe(false);
    expect(result.check).toBe('manifest-wrong-name');
  });

  it('rejects when "primary.filename" points to a file not in the archive', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify({ name: 'submittedWork', primary: { filename: 'missing.json' } }),
    });
    const result = validateArchiveShape(buf);
    expect(result.ok).toBe(false);
    expect(result.check).toBe('primary-not-in-archive');
  });

  it('rejects when the primary query is too short', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify({ name: 'submittedWork', primary: { filename: 'primary_query.json' } }),
      'primary_query.json': JSON.stringify({ query: 'short' }),
    });
    const result = validateArchiveShape(buf);
    expect(result.ok).toBe(false);
    expect(result.check).toBe('primary-query-invalid');
  });

  it('rejects when the primary query is missing entirely', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify({ name: 'submittedWork', primary: { filename: 'primary_query.json' } }),
      'primary_query.json': JSON.stringify({ notQuery: 'oops' }),
    });
    const result = validateArchiveShape(buf);
    expect(result.ok).toBe(false);
    expect(result.check).toBe('primary-query-invalid');
  });
});

describe('validateArchiveShape — entry size caps', () => {
  const big = 'x'.repeat(MAX_JSON_ENTRY_BYTES + 1);

  it('rejects an oversized manifest.json without parsing it', () => {
    const buf = zipOf({ 'manifest.json': `{"pad":"${big}"}` });
    expect(validateArchiveShape(buf).check).toBe('manifest-too-large');
  });

  it('rejects an oversized primary file without parsing it', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify(CONFORMING_SHAPE_EXAMPLE),
      'primary_query.json': JSON.stringify({ query: 'long enough query text', pad: big }),
    });
    expect(validateArchiveShape(buf).check).toBe('primary-too-large');
  });

  it('reports an empty manifest.json as not JSON', () => {
    const buf = zipOf({ 'manifest.json': '' });
    expect(validateArchiveShape(buf).check).toBe('manifest-not-json');
  });
});

describe('archiveShapeLabel', () => {
  it('labels a passing archive "ok"', () => {
    expect(archiveShapeLabel({ ok: true })).toBe('ok');
  });

  it('labels a shape failure "malformed(<check>)"', () => {
    expect(archiveShapeLabel({ ok: false, check: 'primary-not-json' })).toBe('malformed(primary-not-json)');
  });

  it('labels a gateway failure "unknown", never malformed', () => {
    expect(archiveShapeLabel({ ok: false, check: 'gateway-unreachable', gatewayFailure: true })).toBe('unknown');
  });
});

describe('fetchAndValidateArchiveShape', () => {
  const CID = 'QmVfe1hSedejN2xRjjFkkZJ5hA6wVzqQk3moxrT58Ut7oD';
  const conforming = zipOf({
    'manifest.json': JSON.stringify(CONFORMING_SHAPE_EXAMPLE),
    'primary_query.json': JSON.stringify({ query: 'This is my submitted work, please review it.' }),
    'submission.md': '# My work',
  });
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('falls through a failing gateway to the next one', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(url);
      return urls.length === 1 ? new Response('nope', { status: 504 }) : new Response(conforming);
    });
    const result = await fetchAndValidateArchiveShape(CID);
    expect(result).toEqual({ ok: true });
    expect(urls).toHaveLength(2);
    expect(urls.every(u => u.endsWith(`/ipfs/${CID}`))).toBe(true);
  });

  it('never tries the retired cloudflare-ipfs.com gateway', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => { urls.push(url); throw new Error('ECONNREFUSED'); });
    await fetchAndValidateArchiveShape(CID);
    expect(urls.some(u => u.includes('cloudflare-ipfs.com'))).toBe(false);
  });

  it('reports every gateway failing as a gateway failure, not a malformed archive', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await fetchAndValidateArchiveShape(CID);
    expect(result.ok).toBe(false);
    expect(result.gatewayFailure).toBe(true);
    expect(archiveShapeLabel(result)).toBe('unknown');
  });

  it('gives up at the overall deadline instead of waiting on every gateway', async () => {
    // Each gateway hangs until its abort signal fires.
    global.fetch = jest.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const started = Date.now();
    const result = await fetchAndValidateArchiveShape(CID, { perGatewayTimeoutMs: 5000, totalTimeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.gatewayFailure).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a timeout of the attempt that got the rest of the budget as the deadline, whatever the clock says', async () => {
    // The abort timer can fire a millisecond before Date.now() reaches the deadline. Rejecting
    // with TimeoutError at once leaves the clock untouched, so a loop that re-reads the clock
    // would try every gateway; the loop must stop after this one attempt.
    global.fetch = jest.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const result = await fetchAndValidateArchiveShape(CID, { perGatewayTimeoutMs: 5000, totalTimeoutMs: 300 });
    expect(result.gatewayFailure).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an archive whose content-length exceeds the cap without downloading it', async () => {
    global.fetch = jest.fn(async () => new Response(conforming, { headers: { 'content-length': '999999' } }));
    const result = await fetchAndValidateArchiveShape(CID, { maxBytes: 1000 });
    expect(result.ok).toBe(false);
    expect(result.check).toBe('archive-too-large');
    expect(result.gatewayFailure).toBeUndefined();
  });

  it('stops reading a streamed body once it passes the cap', async () => {
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(512)); }, // endless
    });
    global.fetch = jest.fn(async () => new Response(stream));
    const result = await fetchAndValidateArchiveShape(CID, { maxBytes: 4096 });
    expect(result.check).toBe('archive-too-large');
  });

  it('refuses a non-bare CID without fetching anything', async () => {
    global.fetch = jest.fn();
    const result = await fetchAndValidateArchiveShape(`${CID}/../../etc`);
    expect(result.check).toBe('cid-invalid');
    expect(result.gatewayFailure).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
