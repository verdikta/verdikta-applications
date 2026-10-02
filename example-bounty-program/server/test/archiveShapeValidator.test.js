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
const { validateArchiveShape, CONFORMING_SHAPE_EXAMPLE } = require('../utils/archiveShapeValidator');

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
