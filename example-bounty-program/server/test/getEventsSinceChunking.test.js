/**
 * getEventsSince must split long ranges under the RPC's 10,000-block eth_getLogs cap.
 * Before the fix it sent one call for the whole gap, so once the sync fell more
 * than 10K blocks behind (Base Sepolia: ~33 min of 0.2 s blocks) every cycle failed
 * with "range N exceeds limit of 10000" and the gap only grew.
 */

const { ethers } = require('ethers');
const { ContractService, BOUNTY_ESCROW_ABI } = require('../utils/contractService');

const ADDRESS = '0x' + '11'.repeat(20);
const iface = new ethers.Interface(BOUNTY_ESCROW_ABI);
const closed = iface.getEvent('BountyClosed');

function closedLog(bountyId, blockNumber) {
  const encoded = iface.encodeEventLog(closed, closed.inputs.map((i) => {
    if (i.name === 'bountyId') return bountyId;
    if (i.type === 'address') return ADDRESS;
    return 0;
  }));
  return { ...encoded, blockNumber, transactionHash: '0x' + String(bountyId).padStart(64, '0') };
}

function serviceWith(getLogs) {
  const svc = new ContractService('http://127.0.0.1:1', ADDRESS);
  svc.provider = { getLogs };
  return svc;
}

describe('ContractService.getEventsSince', () => {
  test('splits a long range into calls of at most 10,000 blocks, in order', async () => {
    const calls = [];
    const getLogs = jest.fn(async (f) => {
      calls.push(f);
      if (f.toBlock - f.fromBlock + 1 > 10_000) throw new Error('range exceeds limit of 10000');
      // One event at the start of each chunk.
      return [closedLog(calls.length, f.fromBlock)];
    });
    const from = 54_121_256;
    const to = from + 957_166; // the stuck testnet gap
    const events = await serviceWith(getLogs).getEventsSince(from, to);

    expect(calls).toHaveLength(Math.ceil((to - from + 1) / 10_000));
    expect(calls[0].fromBlock).toBe(from);
    expect(calls[calls.length - 1].toBlock).toBe(to);
    for (let i = 1; i < calls.length; i++) expect(calls[i].fromBlock).toBe(calls[i - 1].toBlock + 1);
    expect(calls.every((c) => c.address === ADDRESS)).toBe(true);

    expect(events).toHaveLength(calls.length);
    expect(events[0]).toMatchObject({ name: 'BountyClosed', blockNumber: from });
    expect(events.map((e) => e.blockNumber)).toEqual(calls.map((c) => c.fromBlock));
  });

  test('a range within the cap is still one call', async () => {
    const getLogs = jest.fn(async () => []);
    await serviceWith(getLogs).getEventsSince(100, 10_099);
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs).toHaveBeenCalledWith({ address: ADDRESS, fromBlock: 100, toBlock: 10_099 });
  });

  test('an empty range makes no call', async () => {
    const getLogs = jest.fn(async () => []);
    expect(await serviceWith(getLogs).getEventsSince(200, 199)).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });
});
