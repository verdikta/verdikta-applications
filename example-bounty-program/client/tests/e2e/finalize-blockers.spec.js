import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';

// A passing submission held up by an earlier one nobody finalized (2026-10-18, mainnet
// bounty 255: sub 1 passed and sat at AWAIT_EARLIER behind sub 0, whose failing result
// had been in for hours). Claim must offer to resolve sub 0 first, then claim sub 1.
// The chain is a small simulator behind both the read RPC and the mock wallet.

const ESCROW = '0x1111111111111111111111111111111111111111';
const AGG = '0x2222222222222222222222222222222222222222';
const WINNER = '0xa3b4000000000000000000000000000000000001';
const LOSER = '0x4c72000000000000000000000000000000000002';
const CREATOR = '0xc0ffee0000000000000000000000000000000003';
const BOUNTY = 255;

const SUB = 'tuple(address hunter, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, uint256 submittedAt, uint256 finalizedAt, uint256 ethMaxBudget, uint64 creatorWindowEnd, address funder)';
const BOUNTY_T = 'tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, tuple(uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle)';
const iface = new ethers.Interface([
  `function getBounty(uint256) view returns (${BOUNTY_T})`,
  `function getSubmission(uint256, uint256) view returns (${SUB})`,
  `function getSubmissions(uint256) view returns (${SUB}[])`,
  'function pendingSubmissionIds(uint256) view returns (uint256[])',
  'function nextAction(uint256, uint256) view returns (string)',
  'function getEffectiveBountyStatus(uint256) view returns (string)',
  'function submissionCount(uint256) view returns (uint256)',
  'function bountyCount() view returns (uint256)',
  'function activeEvaluations(uint256) view returns (uint256)',
  'function withdrawable(address) view returns (uint256)',
  'function canBeClosed(uint256) view returns (bool)',
  'function verdikta() view returns (address)',
  'function finalizeSubmission(uint256, uint256)',
  'function failTimedOutSubmission(uint256, uint256)',
  'function closeExpiredBounty(uint256)',
  'function getEvaluation(bytes32) view returns (uint256[], string, bool)',
  'function getAggregationStatus(bytes32) view returns (bool, bool, bool, uint256, uint256, uint256, uint256, uint256, address, uint256)',
  'function responseTimeoutSeconds() view returns (uint256)',
]);
const revert = (reason) => ({ code: 3, message: `execution reverted: ${reason}`,
  data: '0x08c379a0' + ethers.AbiCoder.defaultAbiCoder().encode(['string'], [reason]).slice(2) });

function makeChain({ subs, deadlineOffset = 86400, creator = CREATOR }) {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    bountyStatus: 0, // Open
    deadline: now + deadlineOffset,
    // scores = [DONT_FUND, FUND]; null = no result yet
    subs: subs.map((s, i) => ({ status: 1, aggId: ethers.zeroPadValue(ethers.toBeHex(i + 1), 32), ...s })),
    sent: [],
    receipts: new Map(),
    block: 100,
  };
  const passes = (s) => s.scores && s.scores[1] >= 80;
  const pending = () => state.subs.map((s, i) => (s.status === 1 ? i : -1)).filter((i) => i >= 0);
  const earlierByOther = (id) => pending().some((j) => j < id && state.subs[j].hunter !== state.subs[id].hunter);
  const nextAction = (id) => {
    const s = state.subs[id];
    if (s.status !== 1) return 'DONE';
    if (!s.scores) return s.settled ? 'FORCE_FAIL' : 'AWAIT_ORACLE';
    return state.bountyStatus === 0 && passes(s) && earlierByOther(id) ? 'AWAIT_EARLIER' : 'FINALIZE';
  };
  const subTuple = (s) => [s.hunter, 'QmHunterCid' + 'x'.repeat(35), ethers.ZeroAddress, s.aggId, s.status,
    s.status === 1 ? 0 : s.scores?.[1] ?? 0, s.status === 1 ? 0 : s.scores?.[0] ?? 0, now - 7200, 0, 0n, 0, s.hunter];
  const bountyTuple = () => [creator, 'QmEval' + 'e'.repeat(40), 128, 80, ethers.parseEther('0.01'), now - 86400 * 2,
    state.deadline, state.bountyStatus, ethers.ZeroAddress, state.subs.length, ethers.ZeroAddress, 0n,
    ethers.parseEther('0.01'), 0, [0n, 0n, 0n, 0n]];

  // finalize / force-fail / close: the contract's rules, enough of them for these flows.
  function exec(name, args, { write }) {
    const id = args.length > 1 ? Number(args[1]) : null;
    const s = id != null ? state.subs[id] : null;
    if (name === 'finalizeSubmission') {
      if (s.status !== 1) throw revert('not pending');
      if (!s.scores) throw revert('Verdikta not ready');
      if (state.bountyStatus === 0 && passes(s) && earlierByOther(id)) throw revert('earlier submission pending - retry after it resolves');
      if (write) {
        if (!passes(s)) s.status = 2;
        else if (state.bountyStatus === 0) { s.status = 3; state.bountyStatus = 1; }
        else s.status = 4;
      }
      return '0x';
    }
    if (name === 'failTimedOutSubmission') {
      if (s.status !== 1) throw revert('not pending');
      if (s.scores) throw revert('result available - use finalizeSubmission');
      if (!s.settled) throw revert('evaluation not settled');
      if (write) s.status = 2;
      return '0x';
    }
    if (name === 'closeExpiredBounty') {
      if (pending().length) throw revert('active evaluation - finalize first');
      if (write) state.bountyStatus = 2;
      return '0x';
    }
    throw revert(`not simulated: ${name}`);
  }

  function call(tx) {
    const parsed = iface.parseTransaction({ data: tx.data });
    if (!parsed) throw revert('unknown selector');
    const { name, args } = parsed;
    const enc = (v) => iface.encodeFunctionResult(name, v);
    switch (name) {
      case 'getBounty': return enc([bountyTuple()]);
      case 'getSubmission': return enc([subTuple(state.subs[Number(args[1])])]);
      case 'getSubmissions': return enc([state.subs.map(subTuple)]);
      case 'pendingSubmissionIds': return enc([pending()]);
      case 'nextAction': return enc([nextAction(Number(args[1]))]);
      case 'getEffectiveBountyStatus': return enc([['OPEN', 'AWARDED', 'CLOSED'][state.bountyStatus]]);
      case 'submissionCount': return enc([state.subs.length]);
      case 'bountyCount': return enc([BOUNTY + 1]);
      case 'activeEvaluations': return enc([pending().length]);
      case 'withdrawable': return enc([0]);
      case 'canBeClosed': return enc([state.bountyStatus === 0 && Date.now() / 1000 > state.deadline && !pending().length]);
      case 'verdikta': return enc([AGG]);
      case 'responseTimeoutSeconds': return enc([300]);
      case 'getEvaluation': {
        const s = state.subs.find((x) => x.aggId === args[0]);
        return enc([s?.scores || [], s?.scores ? 'QmJust' : '', !!s?.scores]);
      }
      case 'getAggregationStatus': {
        const s = state.subs.find((x) => x.aggId === args[0]);
        const done = !!s?.scores || !!s?.settled;
        return enc([done, !!s?.settled && !s?.scores, true, 6, 6, s?.scores ? 4 : 0, 3, 2, ESCROW, now - 7200]);
      }
      default: return exec(name, args, { write: false });
    }
  }

  function rpc(method, params = []) {
    switch (method) {
      case 'eth_chainId': return '0x14a34';
      case 'net_version': return '84532';
      case 'eth_accounts': case 'eth_requestAccounts': return [state.from];
      case 'eth_blockNumber': return ethers.toBeHex(state.block);
      case 'eth_getCode': return params[0]?.toLowerCase() === state.from ? '0x' : '0x6080';
      case 'eth_call': return call(params[0]);
      case 'eth_estimateGas': call(params[0]); return '0x30d40';
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
      case 'eth_getBalance': return '0xde0b6b3a7640000';
      case 'eth_getTransactionCount': return ethers.toBeHex(state.sent.length);
      case 'eth_getBlockByNumber': return { number: ethers.toBeHex(state.block), hash: ethers.ZeroHash, parentHash: ethers.ZeroHash,
        timestamp: ethers.toBeHex(Math.floor(Date.now() / 1000)), baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0',
        miner: ethers.ZeroAddress, extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000', transactions: [] };
      case 'eth_sendTransaction': {
        const tx = params[0];
        const { name, args } = iface.parseTransaction({ data: tx.data });
        exec(name, args, { write: true });
        state.block += 1;
        const hash = ethers.keccak256(ethers.toUtf8Bytes(`tx${state.sent.length}`));
        state.sent.push(`${name}(${args.map(String).join(',')})`);
        const base = { hash, from: state.from, to: ESCROW, blockNumber: ethers.toBeHex(state.block), blockHash: ethers.ZeroHash,
          transactionIndex: '0x0' };
        state.receipts.set(hash, {
          tx: { ...base, nonce: ethers.toBeHex(state.sent.length - 1), gas: '0x30d40', value: '0x0', input: tx.data, type: '0x2',
            maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00', chainId: '0x14a34', v: '0x0', r: ethers.ZeroHash, s: ethers.ZeroHash },
          receipt: { ...base, transactionHash: hash, status: '0x1', logs: [], gasUsed: '0x30d40', cumulativeGasUsed: '0x30d40',
            effectiveGasPrice: '0x3b9aca00', contractAddress: null, type: '0x2', logsBloom: '0x' + '0'.repeat(512) },
        });
        return hash;
      }
      case 'eth_getTransactionByHash': return state.receipts.get(params[0])?.tx ?? null;
      case 'eth_getTransactionReceipt': return state.receipts.get(params[0])?.receipt ?? null;
      case 'eth_getLogs': return [];
      default: throw { code: -32601, message: `not simulated: ${method}` };
    }
  }

  const localStatus = (s) => (s.status === 1 ? (s.scores ? (passes(s) ? 'ACCEPTED_PENDING_CLAIM' : 'REJECTED_PENDING_FINALIZATION') : 'PENDING_EVALUATION')
    : s.status === 2 ? 'REJECTED' : 'APPROVED');
  const job = () => ({
    jobId: BOUNTY, title: 'Bounty 255', description: 'Check three claims', creator, bountyAmount: 0.01, bountyAmountWei: '10000000000000000',
    threshold: 80, classId: 128, evaluationCid: 'QmEval' + 'e'.repeat(40), status: ['OPEN', 'AWARDED', 'CLOSED'][state.bountyStatus],
    submissionCloseTime: state.deadline, createdAt: Math.floor(Date.now() / 1000) - 86400 * 2, onChain: true, syncedFromBlockchain: true,
    contractAddress: ESCROW, submissionCount: state.subs.length, publicSubmissions: true,
    submissions: state.subs.map((s, i) => ({ submissionId: i, onChainSubmissionId: i, hunter: s.hunter, status: localStatus(s),
      onChainStatus: ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid'][s.status],
      submittedAt: Math.floor(Date.now() / 1000) - 7200, verdiktaAggId: s.aggId, hunterCid: 'QmHunterCid' + 'x'.repeat(35),
      acceptance: s.scores?.[1] ?? null, rejection: s.scores?.[0] ?? null })),
  });
  return { state, rpc, job };
}

async function openBounty(page, chain, wallet) {
  chain.state.from = wallet;
  await page.addInitScript(() => {
    for (const net of ['base-sepolia', 'base']) localStorage.setItem(`wallet_was_connected_${net}`, 'true');
    window.ethereum = {
      on() {}, removeListener() {},
      request: async ({ method, params }) => {
        const r = await (await fetch('/__wallet', { method: 'POST', body: JSON.stringify({ method, params }) })).json();
        if (r.error) throw Object.assign(new Error(r.error.message), r.error);
        return r.result;
      },
    };
  });
  const answer = (body) => {
    try { return { result: chain.rpc(body.method, body.params) }; } catch (e) { return { error: { code: e.code ?? -32000, message: e.message, data: e.data } }; }
  };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'sepolia.base.org') {
      const body = req.postDataJSON();
      const one = (b) => ({ jsonrpc: '2.0', id: b.id, ...answer(b) });
      return route.fulfill({ json: Array.isArray(body) ? body.map(one) : one(body) });
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.abort();
    if (url.pathname === '/__wallet') return route.fulfill({ json: answer(req.postDataJSON()) });
    if (url.pathname === `/api/jobs/${BOUNTY}`) return route.fulfill({ json: { success: true, job: chain.job() } });
    const sub = url.pathname.match(new RegExp(`^/api/jobs/${BOUNTY}/submissions/(\\d+)/refresh$`));
    if (sub) return route.fulfill({ json: { success: true, submission: chain.job().submissions[Number(sub[1])] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.continue();
  });
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto(`/bounty/${BOUNTY}`);
  return dialogs;
}

test('claiming a passing submission resolves the unfinalized earlier one first', async ({ page }) => {
  const chain = makeChain({ subs: [{ hunter: LOSER, scores: [70, 30] }, { hunter: WINNER, scores: [8, 92] }] });
  const dialogs = await openBounty(page, chain, WINNER);

  await page.getByRole('button', { name: /Claim Bounty/ }).first().click();
  await expect.poll(() => chain.state.sent).toEqual(['finalizeSubmission(255,0)', 'finalizeSubmission(255,1)']);
  expect(dialogs[1]).toContain('Submission #1 passed, but earlier submission(s) #0 by another hunter are still open on-chain');
  expect(dialogs[1]).toContain('That is 1 extra transaction(s) before yours');
  expect(chain.state.subs.map((s) => s.status)).toEqual([2, 3]);   // Failed, PassedPaid
});

test('a blocker still in evaluation is waited out: nothing is sent', async ({ page }) => {
  const chain = makeChain({ subs: [{ hunter: LOSER, scores: null }, { hunter: WINNER, scores: [8, 92] }] });
  const dialogs = await openBounty(page, chain, WINNER);

  await page.getByRole('button', { name: /Claim Bounty/ }).first().click();
  await expect(page.getByText(/earlier submission\(s\) #0 by another hunter are still being evaluated/)).toBeVisible();
  expect(dialogs).toHaveLength(1);   // only the opening "Finalize submission #1?" confirm
  expect(chain.state.sent).toEqual([]);
});

test('closing an expired bounty resolves submissions the site labels *_PENDING_* (on-chain pending list)', async ({ page }) => {
  const chain = makeChain({ deadlineOffset: -3600,
    subs: [{ hunter: LOSER, scores: [70, 30] }, { hunter: WINNER, scores: [60, 40] }] });
  await openBounty(page, chain, CREATOR);

  await page.getByRole('button', { name: /Close (Expired )?Bounty/ }).first().click();
  await expect.poll(() => chain.state.sent, { timeout: 20000 })
    .toEqual(['finalizeSubmission(255,0)', 'finalizeSubmission(255,1)', 'closeExpiredBounty(255)']);
});
