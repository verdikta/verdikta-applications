// What every verb shares: the options, the chain reads and the transactions. Every chain call goes through
// here so that no error of ethers or a node escapes with its text (errors.js), and a read cannot hang past its
// limit. Transactions are write-ahead: the signed bytes are saved first, so a resume sends the same bytes at the
// same nonce, and a new signature is made only when that nonce is proven used.
import { Contract, Interface, Transaction, isAddress } from 'ethers';

import { AGGREGATOR_ABI, STAKE_ATTESTATION_ABI } from './abi.js';
import { fail, revertReasonOf, ToolError } from './errors.js';

/** Base Sepolia and a local node. Dev builder keys are accepted on these, as the arbiters' dev trust is. */
export const ALLOWED_CHAIN_IDS = Object.freeze([84532n, 31337n]);
export const DEFAULT_RPC_URL = 'https://sepolia.base.org';

const DEFAULTS = Object.freeze({
  confirmations: 2,
  waitMs: 180_000,
  readBackMs: 120_000,
  receiptGraceMs: 30_000,
  readTimeoutMs: 30_000,
  logPageBlocks: 2000,
});
const TX_POLL_MS = 2000;

export const sleepReal = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** The promise, or a rejection after `ms`. The timer is cleared either way. */
export function within(promise, ms, onLate) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(onLate()), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function makeContext(options = {}) {
  const ctx = {
    ...DEFAULTS,
    pollMs: null,
    now: Date.now,
    sleep: sleepReal,
    fetch: globalThis.fetch,
    onStep: null,
    onNotice: null,
    onRead: null,
    scrub: null,
    devKeys: null,
    gateway: null,
    pinner: null,
    runner: null,
    signer: null,
    provider: null,
    contract: null,
    ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
  };

  const iface = new Interface(STAKE_ATTESTATION_ABI);
  let chainId = null;
  let sa = null;

  ctx.step = async (name) => {
    if (ctx.onStep) await ctx.onStep(name);
  };
  ctx.notice = (text) => {
    if (ctx.onNotice) ctx.onNotice(text);
  };
  ctx.secret = (value) => ctx.scrub?.add?.(value);

  /** Runs one call to the node: its failure is a code, and only a contract's own reason is ever named. */
  ctx.rpc = async (fn) => {
    try {
      return await within(Promise.resolve().then(fn), ctx.readTimeoutMs, () => fail('RPC_UNAVAILABLE', 'A read timed out.'));
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const reason = revertReasonOf(err);
      if (reason) throw fail('CONTRACT_REFUSED', reason);
      throw fail('RPC_UNAVAILABLE');
    }
  };

  ctx.chainId = () => chainId;

  /** Reads the chain's id every time a verb starts: the only chains are the allowed ones. */
  ctx.ensureChain = async (live = () => true) => {
    if (!ctx.provider) throw fail('USAGE', 'This needs VERDIKTA_RPC_URL.');
    if (!isAddress(ctx.contract)) throw fail('USAGE', 'This needs the StakeAttestation address.');
    const raw = await ctx.rpc(() => ctx.provider.send('eth_chainId', []));
    const id = BigInt(raw);
    if (!ALLOWED_CHAIN_IDS.includes(id)) throw fail('NETWORK_NOT_ALLOWED', `Chain id ${id}.`);
    chainId = id;
    if (!sa) sa = new Contract(ctx.contract, STAKE_ATTESTATION_ABI, ctx.provider);
    if (!live()) throw fail('RPC_UNAVAILABLE', 'The time given is over.');
    const code = await ctx.rpc(() => ctx.provider.getCode(ctx.contract));
    if (code === '0x') throw fail('NOT_THE_CONTRACT');
    return id;
  };

  /** A read at the latest block, or at `blockTag`. @param {string} name @param {unknown[]} [args] */
  ctx.read = (name, args = [], { blockTag } = {}) => ctx.rpc(() => sa.getFunction(name).staticCall(...args, blockTag === undefined ? {} : { blockTag }));

  /** A read right after a write: the node may lag behind its own receipt. */
  ctx.readSettled = async (name, args = []) => {
    const until = ctx.now() + ctx.receiptGraceMs;
    for (;;) {
      try {
        return await ctx.read(name, args);
      } catch (err) {
        if (ctx.now() >= until) throw err;
      }
      await ctx.sleep(ctx.pollMs ?? TX_POLL_MS);
    }
  };

  ctx.chainTime = async () => {
    const block = await ctx.rpc(() => ctx.provider.getBlock('latest'));
    return BigInt(block.timestamp);
  };

  ctx.hunterAddress = async () => {
    if (!ctx.signer) throw fail('WALLET_KEY_MISSING');
    return ctx.signer.getAddress();
  };

  ctx.encode = (name, args) => iface.encodeFunctionData(name, args);
  ctx.parseLog = (log) => {
    try {
      return iface.parseLog(log);
    } catch {
      return null;
    }
  };
  ctx.topics = (eventName, values) => iface.encodeFilterTopics(eventName, values);

  ctx.feeCap = async () => {
    const fee = await ctx.rpc(() => ctx.provider.getFeeData());
    return { maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice ?? 0n, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.gasPrice ?? 0n };
  };

  /** What a call would do now, by a dry run: it throws the contract's reason. */
  ctx.dryRun = ({ data, value = 0n, gasLimit }) => ctx.rpc(async () => {
    const from = await ctx.hunterAddress();
    return ctx.provider.call({ from, to: ctx.contract, data, value, ...(gasLimit ? { gasLimit } : {}) });
  });

  ctx.estimate = ({ data, value = 0n }) => ctx.rpc(async () => {
    const from = await ctx.hunterAddress();
    return ctx.provider.estimateGas({ from, to: ctx.contract, data, value });
  });

  /** Signs a call: the record to save before it is sent. The signed bytes stay on this machine until then. */
  ctx.sign = async ({ data, value = 0n, gasLimit }) => {
    const from = await ctx.hunterAddress();
    const nonce = await ctx.rpc(() => ctx.provider.getTransactionCount(from, 'pending'));
    const fee = await ctx.feeCap();
    let raw;
    try {
      raw = await ctx.signer.signTransaction({ type: 2, chainId, nonce, to: ctx.contract, data, value, gasLimit, ...fee });
    } catch {
      throw fail('INTERNAL', 'The transaction could not be signed.');
    }
    return { hash: Transaction.from(raw).hash, raw, nonce, from, value: value.toString(), gasLimit: gasLimit.toString() };
  };

  /** Sends saved bytes. A node that says it has them, or that their nonce went, is no failure. */
  ctx.broadcast = async (rec) => {
    try {
      await within(ctx.provider.broadcastTransaction(rec.raw), ctx.readTimeoutMs, () => fail('RPC_UNAVAILABLE', 'The send timed out.'));
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const code = err?.code;
      const text = `${err?.message ?? ''} ${err?.info?.error?.message ?? ''} ${err?.error?.message ?? ''}`.toLowerCase();
      if (code === 'NONCE_EXPIRED' || code === 'REPLACEMENT_UNDERPRICED' || /already known|known transaction|nonce too low|already imported|underpriced/.test(text)) return;
      if (code === 'INSUFFICIENT_FUNDS') throw fail('INSUFFICIENT_FUNDS');
      throw fail('RPC_UNAVAILABLE');
    }
  };

  /**
   * Waits for saved bytes to be mined to `confirmations`, or for their nonce to go to something else.
   * @returns {Promise<{ receipt: object } | { gone: true }>}
   * @throws {ToolError} TX_PENDING past waitMs: nothing is lost, and a re-run waits on
   */
  ctx.waitMined = async (rec, { confirmations = 1 } = {}) => {
    const until = ctx.now() + ctx.waitMs;
    let movedAt = null;
    for (;;) {
      const receipt = await ctx.rpc(() => ctx.provider.getTransactionReceipt(rec.hash));
      if (receipt) {
        if (confirmations <= 1) return { receipt };
        const head = await ctx.rpc(() => ctx.provider.getBlockNumber());
        if (head - receipt.blockNumber + 1 >= confirmations) return { receipt };
      } else {
        const next = await ctx.rpc(() => ctx.provider.getTransactionCount(rec.from, 'latest'));
        if (next > rec.nonce) {
          // Used by this transaction with a receipt not yet visible, or by another one: give the node time to say which.
          movedAt ??= ctx.now();
          if (ctx.now() - movedAt >= ctx.receiptGraceMs) return { gone: true };
        } else {
          movedAt = null;
        }
      }
      if (ctx.now() >= until) throw fail('TX_PENDING', `Transaction ${rec.hash}.`);
      await ctx.sleep(ctx.pollMs ?? TX_POLL_MS);
    }
  };

  /**
   * A resume's view of saved bytes: mined, gone, or sent again and waited on. `beforeResend` runs only if they are
   * about to go out again, and can refuse: sending them may be what spends the money.
   */
  ctx.settleSaved = async (rec, { beforeResend = null, ...options_ } = {}) => {
    const receipt = await ctx.rpc(() => ctx.provider.getTransactionReceipt(rec.hash));
    if (!receipt) {
      const next = await ctx.rpc(() => ctx.provider.getTransactionCount(rec.from, 'latest'));
      if (next <= rec.nonce) {
        if (beforeResend) beforeResend();
        await ctx.broadcast(rec);
      }
    }
    return ctx.waitMined(rec, options_);
  };

  /** For calls with nothing to lose on a crash (finalize, settle, withdraw): the chain's state is the resume. */
  ctx.sendSimple = async ({ data, value = 0n }) => {
    const estimate = await ctx.estimate({ data, value });
    const rec = await ctx.sign({ data, value, gasLimit: (estimate * 5n) / 4n + 10000n });
    await ctx.broadcast(rec);
    const { receipt, gone } = await ctx.waitMined(rec);
    if (gone) throw fail('RPC_UNAVAILABLE', 'The transaction was replaced before it was mined.');
    if (receipt.status !== 1) throw fail('CONTRACT_REFUSED', 'The transaction reverted.');
    return { receipt, hash: rec.hash };
  };

  ctx.aggregator = async () => {
    const address = await ctx.read('verdikta');
    return new Contract(address, AGGREGATOR_ABI, ctx.provider);
  };

  return ctx;
}

/** The state's stored claim state as its name, with the lens's Revealable. */
export const stateName = (names, value) => names[Number(value)];
