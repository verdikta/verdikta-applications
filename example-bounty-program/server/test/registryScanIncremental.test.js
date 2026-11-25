// sec4-outside: the oracle walk must not rescan the keeper's whole log history on every cache expiry,
// nor read every key that ever registered (exited ones included).
const { ethers } = require('ethers');
const { VerdiktaService } = require('../utils/verdiktaService');

const IFACE = new ethers.Interface([
  'event ArbiterRegistered(bytes32 indexed key, address indexed oracle, bytes32 jobId, uint256 fee)',
  'event ArbiterRemoved(bytes32 indexed key, uint256 refunded)',
]);
const K = (i) => ethers.zeroPadValue(ethers.toBeHex(i), 32);
const ORACLE = '0x' + '1'.repeat(40);
const reg = (i, block) => ({ ...IFACE.encodeEventLog('ArbiterRegistered', [K(i), ORACLE, K(100 + i), 1n]), blockNumber: block, index: 0 });
const rem = (i, block) => ({ ...IFACE.encodeEventLog('ArbiterRemoved', [K(i), 0n]), blockNumber: block, index: 1 });

function service(logs, headRef) {
  const svc = new VerdiktaService('http://127.0.0.1:1', '0x' + '2'.repeat(40), 100);
  const calls = { getLogs: [], getArbiter: 0 };
  svc.provider = {
    getBlockNumber: async () => headRef.head,
    getLogs: async (f) => { calls.getLogs.push([f.fromBlock, f.toBlock]); return logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock); },
  };
  svc.keeperAddress = '0x' + '3'.repeat(40);
  svc.getReputationKeeper = async () => ({
    interface: IFACE,
    getArbiter: async () => { calls.getArbiter++; return { oracle: ORACLE, flags: 1n, quality: 0n, timeliness: 0n, offenses: 0n, fee: 1n, stake: 1n, blockedUntil: 0n, exitAt: 0n, callSentAt: 0n, callAnsweredAt: 0n }; },
    arbiterClasses: async () => [128n], isFrozen: async () => false,
  });
  return { svc, calls };
}

test('the second walk scans only new blocks, and exited keys are not read', async () => {
  const headRef = { head: 50_000 };
  const logs = [reg(1, 200), reg(2, 300), reg(3, 400), rem(2, 20_000)];
  const { svc, calls } = service(logs, headRef);
  const first = await svc.getAllOracles({ maxAgeMs: 0 });
  expect(first.map((o) => o.key)).toEqual([K(1), K(3)]);
  expect(calls.getArbiter).toBe(2);                      // key 2 exited: not read
  const firstScans = calls.getLogs.length;
  expect(calls.getLogs[0][0]).toBe(100);                 // from the deploy block
  headRef.head = 50_010;
  logs.push(reg(2, 50_005));                             // key 2 comes back
  calls.getLogs = [];
  const second = await svc.getAllOracles({ maxAgeMs: 0 });
  expect(calls.getLogs).toEqual([[50_001, 50_010]]);     // only the new blocks
  expect(second.map((o) => o.key).sort()).toEqual([K(1), K(2), K(3)].sort());
  expect(firstScans).toBeGreaterThan(1);
});
