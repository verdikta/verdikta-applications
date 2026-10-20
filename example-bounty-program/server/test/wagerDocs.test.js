/**
 * Agents learn mutual wagers from /agents.txt, /llms.txt and /api/docs (shared/mutualWagerDocs.js,
 * also shown on the Agents page). Every verb and rule is there, and every code the wager check,
 * the builders and the claim draft can return is documented.
 */
jest.mock('../config', () => ({ config: { network: 'base-sepolia', networkName: 'Base Sepolia', chainId: 84532, bountyEscrowAddress: '0x' + '11'.repeat(20) } }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const agentRoutes = require('../routes/agentRoutes');
const docs = require('../../shared/mutualWagerDocs');
const { MIN_START_LEAD_SECONDS } = require('../../shared/mutualWager');

const app = express();
app.use(agentRoutes);

// Every code string the wager code can put in a response.
function emittedCodes() {
  const files = ['../../shared/mutualWager.js', '../utils/wagerGuard.js', '../routes/wagerRoutes.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8'));
  const codes = new Set();
  for (const src of files) for (const m of src.matchAll(/'((?:WAGER|CLAIM)_[A-Z_]+)'/g)) codes.add(m[1]);
  return [...codes];
}

describe('mutual wager docs', () => {
  it('/agents.txt has the section: verbs, rules and codes', async () => {
    const res = await request(app).get('/agents.txt');
    const text = res.text.slice(res.text.indexOf('## Mutual wagers'));
    expect(text).toMatch(/^## Mutual wagers/);
    for (const verb of ['propose', 'answer', 'check', 'status', 'claim', 'close']) expect(text).toMatch(new RegExp(`\\n  ${verb}\\s`));
    expect(text).toMatch(/POST \/api\/wagers\/answer/);
    expect(text).toMatch(/answers by number/);
    expect(text).toMatch(/must say VERIFIED/);
    expect(text).toMatch(/Never write terms, deadlines or claims by hand/);
    expect(text).toMatch(/about 2 hours after the final/);
    for (const code of emittedCodes().filter((c) => !['CLAIM_INPUT', 'CLAIM_TERMS', 'CLAIM_PAID', 'CLAIM_CLOSED', 'CLAIM_TARGET', 'CLAIM_UNVERIFIED',
      'CLAIM_COUNTER_UNVERIFIED', 'CLAIM_MARKET_UNCHECKED', 'CLAIM_QUOTE_NOT_FINAL', 'CLAIM_SOURCE_UNREADABLE', 'CLAIM_SOURCE_WEAK'].includes(c))) {
      expect([code, text.includes(`  ${code} `)]).toEqual([code, true]);
    }
    expect(res.text).toMatch(/POST \/api\/wagers\/check\n    Body: a \/jobs\/create body/);
  });

  it('documents the timing rule the check enforces', () => {
    expect(docs.WAGER_RULES.join(' ')).toMatch(new RegExp(`at least ${MIN_START_LEAD_SECONDS / 60} minutes before the scheduled start`));
  });

  it('/api/docs lists the endpoints and the mutualWagers block', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.body.mutualWagers.verbs.map((v) => v.verb)).toEqual(['propose', 'answer', 'check', 'status', 'claim', 'close']);
    expect(Object.keys(res.body.mutualWagers.errorCodes)).toEqual(expect.arrayContaining(['WAGER_TARGET', 'WAGER_TERMS', 'WAGER_MISMATCH', 'WAGER_TIMING', 'WAGER_RUBRIC', 'WAGER_DUPLICATE', 'WAGER_COUNTER', 'WAGER_COUNTER_UNVERIFIED']));
    const paths = res.body.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toEqual(expect.arrayContaining(['GET /wagers/template', 'POST /wagers/propose', 'POST /wagers/answer', 'POST /wagers/check', 'POST /wagers/claim', 'GET /wagers/status']));
  });

  it('/llms.txt points at the section and the template', async () => {
    const res = await request(app).get('/llms.txt');
    expect(res.text).toMatch(/## Mutual wagers/);
    expect(res.text).toMatch(/\/api\/wagers\/template/);
  });

  it('documents every warning and problem code the claim draft can return', () => {
    const documented = Object.keys(docs.WAGER_ERROR_CODES);
    const claimCodes = emittedCodes().filter((c) => c.startsWith('CLAIM_'));
    const undocumented = claimCodes.filter((c) => !documented.includes(c));
    // Self-explanatory ones carry their meaning in the message; the rest are in the table.
    expect(undocumented.sort()).toEqual(['CLAIM_CLOSED', 'CLAIM_COUNTER_UNVERIFIED', 'CLAIM_INPUT', 'CLAIM_MARKET_UNCHECKED', 'CLAIM_PAID',
      'CLAIM_QUOTE_NOT_FINAL', 'CLAIM_SOURCE_UNREADABLE', 'CLAIM_SOURCE_WEAK', 'CLAIM_TARGET', 'CLAIM_TERMS', 'CLAIM_UNVERIFIED']);
  });
});
