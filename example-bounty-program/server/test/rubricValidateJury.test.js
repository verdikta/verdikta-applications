/**
 * Regression tests for issue #16 — /rubric/validate ignores juryNodes and
 * accepts model ids with underscores — plus the validate-before-create
 * follow-up: /rubric/validate now also runs the class-map availability check
 * that /jobs/create applies, so a well-formed model that isn't supported by
 * the class (including the dotted-`claude-sonnet-4.6` / issue #15 case) is
 * caught here instead of only at create time.
 *
 * Three angles covered:
 *  1. Pure-function unit tests for `validateModelIdFormat()` covering the
 *     universally-invalid characters (underscore, uppercase, whitespace,
 *     special chars) while letting through real production ids from
 *     OpenAI (dots) and Anthropic (hyphens).
 *  2. Integration tests for POST /api/jobs/rubric/validate confirming
 *     backward-compatible rubric-only mode still works, while a body
 *     with juryNodes now runs the same validator /jobs/create uses and
 *     rejects malformed jury inputs.
 *  3. Availability integration tests: with a valid classId, unsupported
 *     models are flagged (with allowedModels echoed); without a classId the
 *     availability check is skipped and a tip suggests adding one.
 */

jest.mock('../config', () => ({
  config: {
    network: 'base-sepolia',
    bountyEscrowAddress: '0xabc123',
    chainId: 84532,
    explorer: 'https://sepolia.basescan.org',
  },
}));

// Deterministic class map so the availability check (issue #16 follow-up) is
// tested against a fixed model set rather than the live @verdikta/common data,
// which drifts over time. Only `classMap` is overridden; every other export is
// the real one. Class 128 is ACTIVE with a small, known model list.
jest.mock('@verdikta/common', () => {
  const actual = jest.requireActual('@verdikta/common');
  return {
    ...actual,
    classMap: {
      getClass: (id) => (Number(id) === 128
        ? {
            classId: 128,
            status: 'ACTIVE',
            models: [
              { provider: 'anthropic', model: 'claude-sonnet-4-6' },
              { provider: 'openai', model: 'gpt-5.2-2025-12-11' },
              { provider: 'openai', model: 'gpt-5-mini-2025-08-07' },
            ],
          }
        : null),
    },
  };
});

const express = require('express');
const request = require('supertest');
const jobRoutes = require('../routes/jobRoutes');
const {
  validateModelIdFormat,
  validateJuryNodes,
} = require('../utils/validation');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobRoutes);
  return app;
}

const VALID_RUBRIC = {
  criteria: [
    { id: 'a', must: true, weight: 0, description: 'gate' },
    { id: 'b', must: false, weight: 1, description: 'scored' }
  ]
};

function validJury(overrides = {}) {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    runs: 1,
    weight: 1,
    ...overrides
  };
}

describe('validateModelIdFormat() (issue #16)', () => {
  // Allowed — real production ids use these characters and nothing else.
  const ALLOWED = [
    'claude-sonnet-4-6',
    'gpt-5.2-2025-12-11',
    'gpt-5',
    'o3-mini',
    'claude-3-5-sonnet-20241022',
    'gemini-2.0-flash',
    'a',
    '0',
    '123-abc.def',
  ];
  for (const id of ALLOWED) {
    it(`accepts production-style id ${JSON.stringify(id)}`, () => {
      expect(validateModelIdFormat(id)).toBeNull();
    });
  }

  // Rejected — universally invalid characters.
  const REJECTED = [
    ['claude_sonnet_4_6', 'underscores'],
    ['GPT-5', 'uppercase letters'],
    ['claude sonnet', 'whitespace'],
    ['claude-sonnet-4-6/', 'trailing slash'],
    ['claude-sonnet:beta', 'colon variant'],
    ['', 'empty string'],
    [null, 'null'],
    [undefined, 'undefined'],
    [42, 'non-string number'],
  ];
  for (const [id, desc] of REJECTED) {
    it(`rejects ${desc}`, () => {
      expect(validateModelIdFormat(id)).not.toBeNull();
    });
  }
});

describe('validateJuryNodes() now applies validateModelIdFormat()', () => {
  it('rejects underscore model ids', () => {
    const out = validateJuryNodes([validJury({ model: 'claude_sonnet_4_6' })]);
    expect(out.valid).toBe(false);
    expect(out.errors.join('\n')).toMatch(/underscore/i);
  });

  it('rejects uppercase model ids', () => {
    const out = validateJuryNodes([validJury({ model: 'GPT-5' })]);
    expect(out.valid).toBe(false);
    expect(out.errors.join('\n')).toMatch(/uppercase/i);
  });

  it('still rejects runs: 0 (existing behaviour)', () => {
    const out = validateJuryNodes([validJury({ runs: 0 })]);
    expect(out.valid).toBe(false);
    expect(out.errors.join('\n')).toMatch(/Runs must be a number >= 1/);
  });

  it('still rejects missing/invalid provider (existing behaviour)', () => {
    const out = validateJuryNodes([validJury({ provider: undefined })]);
    expect(out.valid).toBe(false);
    expect(out.errors.join('\n')).toMatch(/provider/);
  });

  it('accepts the exact issue #16 repro (anthropic + dotted id + runs:0) and now surfaces both errors', () => {
    // The bug in issue #16 was that — with this exact body — the draft-validator
    // returned {valid:true, errors:[]}. Now it must return both the
    // underscore-style notice AND the runs error.
    const out = validateJuryNodes([{ provider: 'anthropic', model: 'claude-sonnet-4.6', runs: 0, weight: 1 }]);
    expect(out.valid).toBe(false);
    // Body of issue #16: “create” 400s on runs:0. Validator used to silently pass.
    expect(out.errors.some(e => /Runs must be a number >= 1/.test(e))).toBe(true);
    // Note: the dotted-`claude-sonnet-4.6` itself is intentionally NOT caught by this
    // syntax check (issue #15 territory); that's by design and documented above.
  });
});

describe('POST /api/jobs/rubric/validate (issue #16)', () => {
  it('backward-compat: a body with only rubricJson behaves exactly like before — just rubric errors', async () => {
    // Bad rubric (no criteria) — the existing rubric-only validator should still
    // catch this without being confused by the new juryNodes branch.
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({ rubricJson: {} });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.join('\n')).toMatch(/Missing or invalid criteria array/);
    expect(res.body.tips.some(t => /juryNodes/i.test(t))).toBe(true);
  });

  it('issue #16 repro body now returns INVALID instead of {valid:true, errors:[]}', async () => {
    // Exact body from issue #16.
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: VALID_RUBRIC,
        juryNodes: [{ provider: 'anthropic', model: 'claude-sonnet-4.6', runs: 0, weight: 1 }],
        classId: 128,
        workProductType: 'writing',
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    // Must surface the structural jury failure (runs must be >= 1).
    expect(res.body.errors.some(e => /Runs must be a number >= 1/.test(e))).toBe(true);
    // The dot-notation id passes the *syntax* guard (dots are legal — OpenAI
    // uses them), but the availability check now catches it: `claude-sonnet-4.6`
    // is not a real class-128 model, so /jobs/create would reject it. Surfacing
    // it here closes the validate-before-create gap (and resolves the issue #15
    // dotted/known-id case as a side effect of checking the class map).
    expect(res.body.errors.some(e => /claude-sonnet-4\.6.*not available in class 128/.test(e))).toBe(true);
  });

  it('passes when rubric + jury + classId are all valid', async () => {
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: VALID_RUBRIC,
        juryNodes: [validJury(), { provider: 'openai', model: 'gpt-5.2-2025-12-11', runs: 2, weight: 0 }],
        classId: 128,
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.errors).toEqual([]);
  });

  it('flags a well-formed but unsupported model against the class (create-safety gap)', async () => {
    // Syntactically valid id, but not in class 128 — /jobs/create would 400 on
    // this. /rubric/validate must now catch it too, and echo the allowed models.
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: VALID_RUBRIC,
        juryNodes: [{ provider: 'openai', model: 'gpt-4o', runs: 1, weight: 1 }],
        classId: 128,
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.some(e => /gpt-4o.*not available in class 128/.test(e))).toBe(true);
    expect(res.body.allowedModels).toContain('openai/gpt-5.2-2025-12-11');
  });

  it('checks jury structure but skips availability when classId is omitted (tips to add it)', async () => {
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: VALID_RUBRIC,
        juryNodes: [{ provider: 'openai', model: 'gpt-4o', runs: 1, weight: 1 }],
      });
    expect(res.status).toBe(200);
    // No classId → no availability check → the unsupported model is NOT flagged.
    expect(res.body.errors.some(e => /not available/.test(e))).toBe(false);
    expect((res.body.tips || []).join('\n')).toMatch(/classId/);
  });

  it('rejects underscore model ids with a clear message', async () => {
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: VALID_RUBRIC,
        juryNodes: [validJury({ model: 'claude_sonnet_4_6' })],
        classId: 128,
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.join('\n')).toMatch(/underscore/i);
    expect(res.body.errors.join('\n')).toMatch(/claude_sonnet_4_6/);
  });

  it('rejects uppercase model ids with a clear message', async () => {
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: VALID_RUBRIC,
        juryNodes: [validJury({ model: 'GPT-5' })],
        classId: 128,
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.join('\n')).toMatch(/uppercase/i);
    expect(res.body.errors.join('\n')).toMatch(/GPT-5/);
  });

  it('classId is validated as a non-negative integer when juryNodes is provided', async () => {
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: VALID_RUBRIC,
        juryNodes: [validJury()],
        classId: 'mainnet', // wrong type
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.join('\n')).toMatch(/classId must be a non-negative integer/);
  });

  it('omitting classId is fine when juryNodes is provided (optional)', async () => {
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: VALID_RUBRIC,
        juryNodes: [validJury()],
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('merges rubric errors and jury errors together when both are present', async () => {
    const res = await request(buildApp())
      .post('/jobs/rubric/validate')
      .send({
        rubricJson: { criteria: [] }, // invalid rubric
        juryNodes: [validJury({ runs: 0 })], // invalid jury
      });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    // Both error sources must appear.
    expect(res.body.errors.some(e => /at least one/i.test(e))).toBe(true);
    expect(res.body.errors.some(e => /Runs must be a number >= 1/.test(e))).toBe(true);
  });
});
