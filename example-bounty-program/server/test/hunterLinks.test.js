/**
 * utils/hunterLinks.js: finding hunters' parent accounts over plain JSON-RPC and
 * grouping hunters that are linked on chain. Runs against a small simulated chain.
 */
jest.mock('../config', () => ({ config: { network: 'base-sepolia', rpcUrl: 'http://unused' } }));

const os = require('os');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const hl = require('../utils/hunterLinks');

const addr = (b) => '0x' + b.repeat(20);
const H1 = addr('a1'); const H2 = addr('a2'); const H3 = addr('a3'); const H4 = addr('a4');
const W = addr('b1'); // smart-wallet hunter
const FUND = addr('f1'); const EXCH = addr('e1'); const RELAY = addr('d1'); const SMART = addr('c1');
const OWNER = addr('0c'); const BUNDLER = addr('b0'); const DISPERSE = addr('d5'); const TOKEN = addr('70');
const hex = (n) => '0x' + BigInt(n).toString(16);
const pad = (a) => ethers.zeroPadValue(a, 32).toLowerCase();
const T = ethers.id('Transfer(address,address,uint256)');
const ABI = ethers.AbiCoder.defaultAbiCoder();
const sel = (s) => ethers.id(s).slice(0, 10);

/**
 * events: [{ block, tx: {hash, from, to, value, input, type}, credit: {addr: wei}, debit: {addr: wei} }]
 * Balances/nonces are derived per block; code appears at codeAt[addr].
 */
function fakeChain({ latest = 1000, events = [], codeAt = {}, nonces = {}, logs = [], calls = {}, maxLogSpan = Infinity }) {
  const balanceAt = (a, n) => events.filter((e) => e.block <= n)
    .reduce((s, e) => s + BigInt(e.credit?.[a] || 0) - BigInt(e.debit?.[a] || 0), 0n);
  const nonceAt = (a, n) => (nonces[a] && n >= latest ? nonces[a] : 0)
    + events.filter((e) => e.block <= n && e.tx.from === a).length;
  const calls_ = { getLogs: 0 };
  const rpc = {
    calls: calls_,
    async send(method, p) {
      const n = (x) => (x === 'latest' ? latest : Number(BigInt(x)));
      switch (method) {
        case 'eth_blockNumber': return hex(latest + 5);
        case 'eth_getCode': return codeAt[p[0]] != null && n(p[1]) >= codeAt[p[0]].block ? codeAt[p[0]].code : '0x';
        case 'eth_getBalance': return hex(balanceAt(p[0], n(p[1])));
        case 'eth_getTransactionCount': return hex(nonceAt(p[0], n(p[1])));
        case 'eth_getBlockByNumber': return { transactions: events.filter((e) => e.block === n(p[0])).map((e) => e.tx) };
        case 'eth_getBlockReceipts': return events.filter((e) => e.block === n(p[0])).map((e) => e.receipt || { from: e.tx.from, transactionHash: e.tx.hash, logs: [] });
        case 'eth_call': {
          const r = calls[`${p[0].to}:${p[0].data}`];
          if (r === undefined) throw new Error('execution reverted');
          return r;
        }
        case 'eth_getLogs': {
          calls_.getLogs++;
          const { fromBlock, toBlock, topics } = p[0];
          const a = Number(BigInt(fromBlock)); const b = Number(BigInt(toBlock));
          if (b - a + 1 > maxLogSpan) throw new Error('block range too large');
          return logs.filter((l) => l.block >= a && l.block <= b && topics[1].includes(l.topics[1]) && topics[2].includes(l.topics[2]))
            .map((l) => ({ ...l, blockNumber: hex(l.block), logIndex: hex(l.logIndex || 0) }));
        }
        default: throw new Error(`unexpected ${method}`);
      }
    }
  };
  return rpc;
}

const tx = (hash, from, to, value = 0n, input = '0x', type = '0x2') => ({ hash, from, to, value: hex(value), input, type });

describe('findParent', () => {
  test('EOA funded by a plain transfer: the sender is the parent', async () => {
    const rpc = fakeChain({ events: [{ block: 400, tx: tx('0x01', FUND, H1, 5n), credit: { [H1]: 5n } }] });
    expect(await hl.findParent(rpc, H1, 1000)).toMatchObject({ kind: 'eoa', parent: FUND, via: 'direct', parentTx: '0x01', parentBlock: 400 });
  });

  test('L1 bridge deposit is labelled as such', async () => {
    const rpc = fakeChain({ events: [{ block: 7, tx: tx('0x02', FUND, H1, 5n, '0x', '0x7e'), credit: { [H1]: 5n } }] });
    expect(await hl.findParent(rpc, H1, 1000)).toMatchObject({ parent: FUND, via: 'deposit' });
  });

  test('relayed smart-account transfer credits the account whose balance dropped, not the relayer', async () => {
    const input = sel('redeem(bytes)') + pad(DISPERSE).slice(2) + pad(SMART).slice(2) + pad(H1).slice(2);
    const rpc = fakeChain({ events: [
      { block: 10, tx: tx('0x00', FUND, SMART, 50n), credit: { [SMART]: 50n } },
      { block: 300, tx: tx('0x03', RELAY, DISPERSE, 0n, input), credit: { [H1]: 9n }, debit: { [SMART]: 9n } },
    ] });
    expect(await hl.findParent(rpc, H1, 1000)).toMatchObject({ parent: SMART, relayer: RELAY, via: 'contract-call', parentTx: '0x03' });
  });

  test('disperse-style call: value comes from the tx sender', async () => {
    const input = sel('disperseEther(address[],uint256[])') + pad(H1).slice(2);
    const rpc = fakeChain({ events: [
      { block: 1, tx: tx('0x00', EXCH, FUND, 100n), credit: { [FUND]: 100n } },
      { block: 50, tx: tx('0x04', FUND, DISPERSE, 9n, input), credit: { [H1]: 9n }, debit: { [FUND]: 9n } },
    ] });
    const r = await hl.findParent(rpc, H1, 1000);
    expect(r).toMatchObject({ parent: FUND, via: 'contract-call' });
    expect(r.relayer).toBeUndefined();
  });

  test('never-funded EOA', async () => {
    expect(await hl.findParent(fakeChain({}), H1, 1000)).toMatchObject({ parent: null, via: 'none' });
  });

  test('EIP-7702 delegated EOA is treated as an EOA', async () => {
    const rpc = fakeChain({
      events: [{ block: 20, tx: tx('0x05', FUND, H1, 1n), credit: { [H1]: 1n } }],
      codeAt: { [H1]: { block: 30, code: '0xef0100' + 'ab'.repeat(20) } }
    });
    expect(await hl.findParent(rpc, H1, 1000)).toMatchObject({ kind: 'eoa', parent: FUND });
  });

  test('smart wallet: address owners are the parents (Coinbase Smart Wallet ownerAtIndex)', async () => {
    const ownerBytes = ABI.encode(['bytes'], [ABI.encode(['address'], [OWNER])]);
    const passkey = ABI.encode(['bytes'], ['0x' + '11'.repeat(64)]);
    const rpc = fakeChain({
      events: [{ block: 600, tx: tx('0x06', BUNDLER, addr('ee')), receipt: { from: BUNDLER, transactionHash: '0x06', logs: [{ address: W, topics: [] }] } }],
      codeAt: { [W]: { block: 600, code: '0x6080' } },
      calls: {
        [`${W}:${sel('nextOwnerIndex()')}`]: ABI.encode(['uint256'], [2]),
        [`${W}:${sel('ownerAtIndex(uint256)')}${ABI.encode(['uint256'], [0]).slice(2)}`]: ownerBytes,
        [`${W}:${sel('ownerAtIndex(uint256)')}${ABI.encode(['uint256'], [1]).slice(2)}`]: passkey,
      }
    });
    expect(await hl.findParent(rpc, W, 1000)).toMatchObject({ kind: 'contract', parent: OWNER.toLowerCase(), owners: [OWNER.toLowerCase()], via: 'owner', parentTx: '0x06', parentBlock: 600 });
  });

  test('smart wallet with no readable owner falls back to the creating tx sender', async () => {
    const rpc = fakeChain({
      events: [{ block: 600, tx: tx('0x07', BUNDLER, null), receipt: { from: BUNDLER, transactionHash: '0x07', contractAddress: W, logs: [] } }],
      codeAt: { [W]: { block: 600, code: '0x6080' } }
    });
    expect(await hl.findParent(rpc, W, 1000)).toMatchObject({ parent: BUNDLER, via: 'creation', parentTx: '0x07' });
  });
});

describe('buildConnections', () => {
  const base = () => ({ addresses: {}, funders: {}, tokens: {}, transfers: [], tokenScan: { cursor: 1 }, lastRunAt: 1 });

  test('funded-by-hunter, shared personal funder and token transfers link hunters; hubs do not', () => {
    const s = base();
    s.addresses = {
      [H1]: { parent: FUND, via: 'direct', parentTx: '0x1' },
      [H2]: { parent: FUND, via: 'direct', parentTx: '0x2' },
      [H3]: { parent: H2, via: 'direct', parentTx: '0x3' },
      [H4]: { parent: EXCH, via: 'direct', parentTx: '0x4' },
      [W]: { parent: EXCH, via: 'direct', parentTx: '0x5' },
    };
    s.funders = { [FUND]: { nonce: 3, hub: false }, [EXCH]: { nonce: 500000, hub: true } };
    s.transfers = [{ from: H4, to: W, token: TOKEN, txHash: '0x9', logIndex: 0, block: 5 }];
    s.tokens = { [TOKEN]: 'USDC' };
    const c = hl.buildConnections(s, [H1, H2, H3, H4, W]);

    expect(c.groups.map((g) => g.addresses.sort())).toEqual([[H1, H2, H3].sort(), [H4, W].sort()]);
    expect(c.groups[0].links.map((l) => l.type).sort()).toEqual(['funded', 'shared-funder']);
    expect(c.groups[1].links).toEqual([expect.objectContaining({ type: 'token-transfer', symbol: 'USDC', count: 1 })]);
    expect(c.hubs).toEqual([expect.objectContaining({ funder: EXCH, hunters: 2, nonce: 500000 })]);
    expect(c.groupOf).toMatchObject({ [H1]: 1, [H4]: 2 });
    expect(c.coverage).toMatchObject({ hunters: 5, linkedHunters: 5 });
  });

  test('a common smart-wallet owner links hunters even if the owner is busy', () => {
    const s = base();
    s.addresses = {
      [W]: { kind: 'contract', parent: OWNER, owners: [OWNER], via: 'owner' },
      [H1]: { kind: 'contract', parent: OWNER, owners: [OWNER], via: 'owner' },
    };
    s.funders = { [OWNER]: { nonce: 99999, hub: true } };
    const c = hl.buildConnections(s, [W, H1]);
    expect(c.groups).toHaveLength(1);
    expect(c.groups[0].links[0]).toMatchObject({ type: 'shared-funder', relation: 'owner' });
    expect(c.hubs).toEqual([]);
  });

  test('a funder not yet checked is not trusted to link', () => {
    const s = base();
    s.addresses = { [H1]: { parent: FUND, via: 'direct' }, [H2]: { parent: FUND, via: 'direct' } };
    const c = hl.buildConnections(s, [H1, H2]);
    expect(c.groups).toEqual([]);
    expect(c.hubs[0]).toMatchObject({ funder: FUND, unchecked: true });
  });
});

describe('runAnalysis', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hl-')), 'state.json');

  test('finds parents, rates funders, scans token transfers (shrinking the log range) and resumes incrementally', async () => {
    const file = tmp();
    const logs = [{ address: TOKEN, topics: [T, pad(H1), pad(H2)], transactionHash: '0xt1', block: 700 }];
    const chain = fakeChain({
      events: [
        { block: 100, tx: tx('0x01', FUND, H1, 5n), credit: { [H1]: 5n } },
        { block: 200, tx: tx('0x02', FUND, H2, 5n), credit: { [H2]: 5n } },
      ],
      nonces: { [FUND]: 2 },
      logs,
      calls: { [`${TOKEN}:0x95d89b41`]: ABI.encode(['string'], ['USDC']) },
      maxLogSpan: 300
    });
    await hl.runAnalysis([H1, H2], { state: chain, logs: chain }, { file });
    let state = await hl.readState(file);
    expect(state.addresses[H1]).toMatchObject({ parent: FUND, parentBlock: 100 });
    expect(state.funders[FUND]).toMatchObject({ nonce: 4, hub: false });
    expect(state.transfers).toEqual([expect.objectContaining({ from: H1, to: H2, token: TOKEN, block: 700 })]);
    expect(state.tokens[TOKEN]).toBe('USDC');
    expect(state.tokenScan).toMatchObject({ cursor: 1000, covered: [H1, H2] });
    let c = hl.buildConnections(state, [H1, H2]);
    expect(c.groups).toHaveLength(1);

    // New hunter: only it is analyzed, and its history is backfilled
    chain.calls.getLogs = 0;
    const H3events = fakeChain({
      events: [
        { block: 100, tx: tx('0x01', FUND, H1, 5n), credit: { [H1]: 5n } },
        { block: 200, tx: tx('0x02', FUND, H2, 5n), credit: { [H2]: 5n } },
        { block: 900, tx: tx('0x03', H2, H3, 1n), credit: { [H3]: 1n } },
      ],
      nonces: { [FUND]: 2 }, logs, maxLogSpan: 300
    });
    await hl.runAnalysis([H1, H2, H3], { state: H3events, logs: H3events }, { file });
    state = await hl.readState(file);
    expect(state.addresses[H3]).toMatchObject({ parent: H2, via: 'direct', parentBlock: 900 });
    expect(state.tokenScan.covered.sort()).toEqual([H1, H2, H3].sort());
    expect(state.transfers).toHaveLength(1); // deduplicated
    c = hl.buildConnections(state, [H1, H2, H3]);
    expect(c.groups[0].addresses.sort()).toEqual([H1, H2, H3].sort());
  });

  test('a failed lookup is retried next run and kept out of token-scan coverage', async () => {
    const file = tmp();
    const ok = fakeChain({ events: [{ block: 100, tx: tx('0x01', FUND, H1, 5n), credit: { [H1]: 5n } }] });
    const flaky = { send: async (m, p) => { if (p && p[0] === H2 && m !== 'eth_getLogs') throw new Error('boom'); return ok.send(m, p); } };
    await hl.runAnalysis([H1, H2], { state: flaky, logs: ok }, { file });
    let state = await hl.readState(file);
    expect(state.addresses[H2].error).toBe('boom');
    expect(state.tokenScan.covered).toEqual([H1]);

    await hl.runAnalysis([H1, H2], { state: ok, logs: ok }, { file });
    state = await hl.readState(file);
    expect(state.addresses[H2]).toMatchObject({ via: 'none' });
    expect(state.tokenScan.covered.sort()).toEqual([H1, H2].sort());
  });
});

test('addressesInCalldata picks address-shaped words only', () => {
  const input = sel('f(address,uint256,address)') + pad(H1).slice(2) + ABI.encode(['uint256'], [64]).slice(2) + pad(H2).slice(2);
  expect(hl.addressesInCalldata(input)).toEqual([H1, H2]);
});
