/**
 * GET /mine/action-required must not treat a failed chain read as "needs
 * attention" (2026-11-10 report: RPC failures raised a false "expired bounty
 * needs your attention" banner). Failed reads go to `unverified`, never into
 * `count`, and a failed submission read never yields canClose: true.
 */

const { buildActionRequired, withRetry } = require('../utils/actionRequired');

const CREATOR = '0xC0ffee0000000000000000000000000000000001';
const OTHER = '0x9999000000000000000000000000000000000003';
const NOW = 2_000_000_000;

function job(jobId, extra = {}) {
  return {
    jobId, title: `Bounty ${jobId}`, creator: CREATOR, status: 'EXPIRED',
    submissionCloseTime: NOW - 3600, onChain: true, bountyAmount: '0.01', ...extra
  };
}

// chain[bountyId] = { status, payoutWei, pending: [ids], subs: {id: {status}} }
// fail = { getBounty: Set, pending: Set, getSubmission: Set } of bountyIds
function mockChain(chain, fail = {}) {
  const err = () => Object.assign(new Error('could not detect network'), { code: 'NETWORK_ERROR' });
  return {
    getBounty: jest.fn(async (b) => {
      if (fail.getBounty?.has(Number(b))) throw err();
      return { status: chain[b].status, payoutWei: BigInt(chain[b].payoutWei || 0) };
    }),
    pendingSubmissionIds: jest.fn(async (b) => {
      if (fail.pending?.has(Number(b))) throw err();
      return (chain[b].pending || []).map(BigInt);
    }),
    getSubmission: jest.fn(async (b, id) => {
      if (fail.getSubmission?.has(Number(b))) throw err();
      return {
        status: chain[b].subs?.[id]?.status ?? 1, hunter: OTHER,
        submittedAt: NOW - 600, verdiktaAggId: '0x' + '1'.padStart(64, '0')
      };
    }),
  };
}
const cs = { getForceFailEligibility: jest.fn(async () => ({ eligible: false, hasResult: true })) };

const run = (jobs, contract) =>
  buildActionRequired({ jobs, creator: CREATOR, contract, cs, nowSeconds: NOW, retryDelayMs: 0 });

describe('buildActionRequired', () => {
  test('getBounty RPC failure → unverified, not counted', async () => {
    const contract = mockChain({ 1: { status: 2 } }, { getBounty: new Set([1]) });
    const body = await run([job(1)], contract);
    expect(body.count).toBe(0);
    expect(body.blockedCount).toBe(0);
    expect(body.bounties).toEqual([]);
    expect(body.unverifiedCount).toBe(1);
    expect(body.unverified[0]).toMatchObject({ jobId: 1, unverified: true, canClose: false });
    expect(body.unverified[0].blockedBy).toMatch(/could not detect network/);
    expect(contract.getBounty).toHaveBeenCalledTimes(2); // retried once
  });

  test('no contract service → unverified, not counted', async () => {
    const body = await run([job(1)], null);
    expect(body.count).toBe(0);
    expect(body.unverifiedCount).toBe(1);
  });

  test('submission read failure → unverified, never "Ready to close"', async () => {
    const contract = mockChain({ 1: { status: 0, pending: [0] } }, { getSubmission: new Set([1]) });
    const body = await run([job(1)], contract);
    expect(body.readyToCloseCount).toBe(0);
    expect(body.count).toBe(0);
    expect(body.unverifiedCount).toBe(1);
  });

  test('pendingSubmissionIds failure → unverified', async () => {
    const contract = mockChain({ 1: { status: 0 } }, { pending: new Set([1]) });
    const body = await run([job(1)], contract);
    expect(body.unverifiedCount).toBe(1);
    expect(body.count).toBe(0);
  });

  test('transient failure recovers on retry', async () => {
    const contract = mockChain({ 1: { status: 0, payoutWei: 10n ** 16n } });
    contract.getBounty.mockRejectedValueOnce(new Error('timeout'));
    const body = await run([job(1)], contract);
    expect(body.unverifiedCount).toBe(0);
    expect(body.readyToCloseCount).toBe(1);
    expect(body.totalReclaimableEth).toBe('0.01');
  });

  test('healthy reads: open-no-pending ready, open-with-pending blocked, closed/awarded skipped', async () => {
    const contract = mockChain({
      1: { status: 0, payoutWei: 10n ** 16n },
      2: { status: 0, pending: [0, 1], subs: { 0: { status: 1 }, 1: { status: 3 } } },
      3: { status: 1 },
      4: { status: 2 },
    });
    const body = await run([job(1), job(2), job(3), job(4)], contract);
    expect(body.count).toBe(2);
    expect(body.readyToCloseCount).toBe(1);
    expect(body.blockedCount).toBe(1);
    const blocked = body.bounties.find(b => b.jobId === 2);
    expect(blocked.pendingSubmissions.map(s => s.submissionId)).toEqual([0]);
    expect(blocked.pendingSubmissions[0].action).toBe('finalize');
    expect(body.unverifiedCount).toBe(0);
  });

  test('locally CLOSED/AWARDED bounties are skipped without any RPC', async () => {
    const contract = mockChain({}, { getBounty: new Set([1, 2]) });
    const body = await run([job(1, { status: 'CLOSED' }), job(2, { status: 'AWARDED' })], contract);
    expect(contract.getBounty).not.toHaveBeenCalled();
    expect(body.count).toBe(0);
    expect(body.unverifiedCount).toBe(0);
  });

  test('filters: other creator, not-yet-expired, unlinked', async () => {
    const contract = mockChain({});
    const body = await run([
      job(1, { creator: OTHER }),
      job(2, { submissionCloseTime: NOW + 60 }),
      job(3, { onChain: false, syncedFromBlockchain: false }),
    ], contract);
    expect(contract.getBounty).not.toHaveBeenCalled();
    expect(body.count).toBe(0);
    expect(body.unverifiedCount).toBe(0);
  });
});

describe('withRetry', () => {
  test('throws the last error after exhausting tries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('down'));
    await expect(withRetry(fn, 2, 0)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
