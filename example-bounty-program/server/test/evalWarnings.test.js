/**
 * Tests for extractEvaluationWarnings — defensively surfaces oracle warnings
 * (esp. attachment_skipped) from a parsed evaluation report whose exact shape varies.
 */
const { extractEvaluationWarnings } = require('../utils/validation');

describe('extractEvaluationWarnings', () => {
  it('returns [] for content with no warnings', () => {
    expect(extractEvaluationWarnings({ scores: { acceptance: 90 }, feedback: 'good' })).toEqual([]);
    expect(extractEvaluationWarnings(null)).toEqual([]);
    expect(extractEvaluationWarnings('just a string')).toEqual([]);
  });

  it('pulls a top-level warnings array', () => {
    const w = extractEvaluationWarnings({ warnings: ['attachment_skipped: solution.zip', 'low_confidence'] });
    expect(w).toContain('attachment_skipped: solution.zip');
    expect(w).toContain('low_confidence');
  });

  it('pulls warnings nested inside per-justification objects (array form)', () => {
    const report = [
      { model: 'gpt-5.2', score: 0, warnings: ['attachment_skipped: data.bin'] },
      { model: 'claude-haiku', score: 0, warnings: [] },
    ];
    expect(extractEvaluationWarnings(report)).toEqual(['attachment_skipped: data.bin']);
  });

  it('handles an attachment_skipped key directly (object or string value)', () => {
    expect(extractEvaluationWarnings({ attachment_skipped: 'work.tar.gz' })).toContain('work.tar.gz');
    const obj = extractEvaluationWarnings({ evaluation: { attachment_skipped: { file: 'x.zip', reason: 'binary' } } });
    expect(obj.length).toBe(1);
    expect(obj[0]).toMatch(/x\.zip/);
  });

  it('de-duplicates repeated warnings', () => {
    const report = {
      a: { warnings: ['attachment_skipped: f.zip'] },
      b: { warnings: ['attachment_skipped: f.zip'] },
    };
    expect(extractEvaluationWarnings(report)).toEqual(['attachment_skipped: f.zip']);
  });

  it('is robust to deep nesting and mixed types', () => {
    const report = { results: { jury: [{ detail: { warnings: ['skipped'] } }] }, meta: { count: 1 } };
    expect(extractEvaluationWarnings(report)).toContain('skipped');
  });
});
