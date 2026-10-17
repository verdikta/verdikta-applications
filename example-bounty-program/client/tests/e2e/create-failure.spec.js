import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { preview } from '../../../../skills/verdikta-discover/scripts/preview-core.mjs';

// A website create whose wallet step fails (2026-10-16: jobs 287, 288, 298-303
// never reached the chain and nothing said why). The API is stubbed and the
// wallet is a mock that rejects the signature: the page must name the step,
// say nothing was charged, and report sign_requested + failed for the job.

const CREATOR = '0x5addea6020bca2edd41ec47297bf95922ffddaf0';
const DELEGATE = '63c0c19a282a1b52b07dd5a65b58948a07dae32b';
const JOB_ID = 298;
const API = {
  '/api/classes': { success: true, classes: [{ id: 128, status: 'ACTIVE', name: 'OpenAI & Anthropic Core', description: 'Core panel' }] },
  '/api/classes/128/models': { success: true, listed: true, classId: 128, className: 'OpenAI & Anthropic Core', status: 'ACTIVE',
    models: [{ provider: 'openai', model: 'gpt-5.2-2025-12-11' }],
    modelsByProvider: { openai: [{ provider: 'openai', model: 'gpt-5.2-2025-12-11' }] }, limits: null },
  '/api/classes/128/coverage': { success: true, classId: 128, listed: true, className: 'Core', servable: true, refusal: null, warnings: [],
    coverage: { checked: true, classId: 128, totalInClass: 22, activeInClass: 22, eligibleCount: 22, pricedOutCount: 0, distinctOwnersEligible: 4, oraclesToPoll: 6, maxOracleFeeEth: '0.00002', creatorOperatedCount: 0 } },
};
const example = JSON.parse(await readFile(new URL('../../../../skills/verdikta-discover/examples/source-check-v1.request.json', import.meta.url), 'utf8'));
const draft = preview({ request: { ...example, fixture_only: false, task_id: 'e2e-create-failure' },
  task_summary: 'Check three claims (e2e)', sharing_authorized: true, procurement_mode: 'OPEN' });

test('a rejected signature is explained and reported against the API job', async ({ page }) => {
  await page.addInitScript(({ creator, delegate }) => {
    for (const net of ['base-sepolia', 'base']) localStorage.setItem(`wallet_was_connected_${net}`, 'true');
    window.walletCalls = [];
    const word = '0x' + '0'.repeat(64);
    window.ethereum = {
      on() {},
      removeListener() {},
      request: async ({ method }) => {
        window.walletCalls.push(method);
        switch (method) {
          case 'eth_accounts': case 'eth_requestAccounts': return [creator];
          case 'eth_chainId': return '0x14a34';
          case 'net_version': return '84532';
          case 'eth_getCode': return '0xef0100' + delegate;   // an EIP-7702 account, like the 2026-10-16 poster
          case 'eth_call': return word;                         // the pre-check passes
          case 'eth_estimateGas': return '0x30d40';
          case 'eth_blockNumber': return '0x10';
          case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
          case 'eth_getBalance': return '0xde0b6b3a7640000';
          case 'eth_getTransactionCount': return '0x314';
          case 'eth_getBlockByNumber': return { number: '0x10', baseFeePerGas: '0x3b9aca00', timestamp: '0x0', hash: word, parentHash: word, transactions: [] };
          case 'eth_sendTransaction': throw Object.assign(new Error('MetaMask Tx Signature: User denied transaction signature.'), { code: 4001 });
          default: throw new Error(`not mocked: ${method}`);
        }
      },
    };
  }, { creator: CREATOR, delegate: DELEGATE });

  const reports = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/api/jobs/create' && req.method() === 'POST') {
      return route.fulfill({ json: { success: true, job: { jobId: JOB_ID, evaluationCid: 'Qm' + 'a'.repeat(44), rubricCid: 'Qm' + 'b'.repeat(44) } } });
    }
    if (url.pathname === `/api/jobs/${JOB_ID}/create-attempt`) {
      reports.push({ body: req.postDataJSON(), headers: req.headers() });
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname in API) return route.fulfill({ json: API[url.pathname] });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.continue();
  });

  await page.goto('/create');
  const panel = page.locator('.work-order-import');
  await panel.getByLabel('Work-order draft JSON').fill(JSON.stringify(draft));
  await panel.getByRole('button', { name: 'Import pasted JSON' }).click();
  await expect(panel.getByText('Imported draft', { exact: true })).toBeVisible();
  await page.locator('.step', { hasText: 'AI Jury' }).click();
  await page.getByRole('button', { name: /Create Bounty/ }).click();

  const alert = page.locator('.alert.alert-error').first();
  await expect(alert).toContainText('Your wallet did not send the transaction (it was rejected in the wallet). Nothing was charged.');
  await expect(alert).toContainText('Details: MetaMask Tx Signature: User denied transaction signature.');

  await expect.poll(() => reports.map((r) => r.body.event)).toEqual(['sign_requested', 'failed']);
  const failed = reports[1].body;
  expect(failed).toMatchObject({
    creator: CREATOR, step: 'send', category: 'rejected_in_wallet', code: 'ACTION_REJECTED', rpcCode: 4001,
    chainId: 84532, accountType: 'eip7702', delegate: `0x${DELEGATE}`, browser: 'chrome', mobile: false,
  });
  expect(failed.walletMessage).toMatch(/User denied transaction signature/);
  // Nothing beyond the classified error and wallet context: no user agent, no form.
  expect(Object.keys(failed).sort()).toEqual(['accountType', 'at', 'browser', 'category', 'chainId', 'code', 'creator',
    'delegate', 'elapsedMs', 'event', 'message', 'mobile', 'rpcCode', 'step', 'wallet', 'walletMessage'].sort());
  for (const r of reports) expect(r.headers['content-type']).toBe('application/json');
  expect(await page.evaluate(() => window.walletCalls.includes('eth_sendTransaction'))).toBe(true);
});
