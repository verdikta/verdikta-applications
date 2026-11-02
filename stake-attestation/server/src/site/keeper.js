// The keeper (node P4b1, erratum E4): the aggregator never calls back, so the site calls
// finalize(claimId) once a claim's round is over, settle(claimId) once a judged claim may settle,
// and, with SA_KEEPER_EXPIRE=on, expire(claimId) once a claim nobody can advance may be expired.
// All three are permissionless and move funds by the claim's record, never by the caller.
//
// Idempotence. The indexed events only say which claims to look at. Before every send the keeper
// reads the claim on-chain and simulates the call at the latest block; a call that would revert is
// not sent. It has at most one transaction in flight, at the account's next confirmed nonce, and
// records it in the store (the signed bytes included) before broadcasting it. The next cycle, or
// the next process, resolves that record before doing anything else:
//   - the nonce was used: by one of the recorded attempts (its receipt is the outcome) or by
//     another transaction of this key (a second keeper's); either way the record is done;
//   - still pending and young: wait for it;
//   - pending past SA_KEEPER_REPLACE_AFTER_MS, or gone from the node: if the call is still due,
//     re-send it at the same nonce with higher fees; if not, replace a pending one with a 0-value
//     transfer to itself, so a stale call never reaches a block to revert there.
// Only one transaction can be mined at a nonce, so a retry, a restart or a second keeper with the
// same key never makes a call twice. Keepers with different keys share nothing but the chain:
// each reads the claim before it sends, but two that send in the same block can still race, and
// one would revert; run one keeper per deployment, or give them one key.
import { Transaction, Wallet } from 'ethers';

import { ENUMS, stakeAttestation } from '../chain/abi.js';

const POLL_MS = 100;
const BUMP_NUM = 9n; // fees x 9/8 (+1 wei) for a replacement: above the 10% nodes require
const BUMP_DEN = 8n;
const ACTION_STATES = Object.freeze({ finalize: ['Revealed', 'Disputed'], settle: ['Judged'], expire: ['Committed', 'RoundFailed'] });

export class KeeperError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'KeeperError';
    this.code = code;
  }
}

/** The keeper's wallet from the environment variable config.keeper.keyEnv names. */
export function keeperWallet(cfg, env) {
  const raw = env[cfg.keyEnv];
  if (typeof raw !== 'string' || !raw.trim()) return { wallet: null, error: 'KEEPER_KEY_MISSING' };
  try {
    return { wallet: new Wallet(raw.trim()), error: null };
  } catch {
    return { wallet: null, error: 'KEEPER_KEY_INVALID' }; // never the value, nor ethers' message about it
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpcText(err) {
  return [err?.code, err?.shortMessage, err?.message, err?.error?.message, err?.info?.error?.message].filter(Boolean).join(' | ');
}

/** What a node's refusal of eth_sendRawTransaction means. */
function broadcastRefusal(err) {
  const t = rpcText(err);
  if (/known transaction|already known|already imported|already in (the )?mempool/i.test(t)) return 'known';
  if (/NONCE_EXPIRED|nonce too low|nonce has already been used/i.test(t)) return 'nonce-used';
  if (/REPLACEMENT_UNDERPRICED|replacement (transaction|fee) (underpriced|too low)/i.test(t)) return 'underpriced';
  return null;
}

/**
 * @param {object} o
 * @param {import('ethers').Provider} o.provider
 * @param {import('./store.js').StateStore} o.store
 * @param {object} o.chain - config.chain
 * @param {object} o.cfg - config.keeper
 * @param {Wallet} o.wallet - not connected; the keeper signs and broadcasts itself
 * @param {() => object} o.projection - the projection of the indexed events
 * @param {object} o.logger
 * @param {{ beforeBroadcast?: () => void|Promise<void> }} [o.hooks]
 * @param {() => number} [o.now] - ms
 */
export function createKeeper({ provider, store, chain, cfg, wallet, projection, logger, hooks = {}, now = Date.now }) {
  const address = wallet.address;
  let running = false;

  const tx = (to, data) => ({ from: address, to, data, blockTag: 'latest' });
  const callData = (action, claimId) => stakeAttestation.encodeFunctionData(action, [claimId]);

  async function claimState(claimId) {
    const c = await provider.call(tx(chain.address, stakeAttestation.encodeFunctionData('getClaim', [claimId])));
    const [claim] = stakeAttestation.decodeFunctionResult('getClaim', c);
    return ENUMS.ClaimState[Number(claim.state)];
  }

  /** Whether `action` on the claim would succeed now: the stored state allows it and a simulation passes. */
  async function isDue(action, claimId, known = null) {
    const state = known ?? await claimState(claimId);
    if (!ACTION_STATES[action].includes(state)) return false;
    if (action === 'settle') {
      const [at] = stakeAttestation.decodeFunctionResult('settleableAt', await provider.call(tx(chain.address, stakeAttestation.encodeFunctionData('settleableAt', [claimId]))));
      const latest = await provider.getBlock('latest');
      if (at === 0n || at > BigInt(latest.timestamp)) return false;
    }
    try {
      await provider.call(tx(chain.address, callData(action, claimId)));
      return true;
    } catch {
      return false; // "evaluation not ready", a window still open, or done by someone else
    }
  }

  /** The action due for a claim now, by its on-chain state, or null. */
  async function dueAction(claimId) {
    const state = await claimState(claimId);
    for (const action of ['finalize', 'settle', ...(cfg.expire ? ['expire'] : [])]) {
      if (ACTION_STATES[action].includes(state)) return (await isDue(action, claimId, state)) ? action : null;
    }
    return null;
  }

  async function fees(previous) {
    const f = await provider.getFeeData();
    let maxFee = f.maxFeePerGas ?? f.gasPrice;
    let tip = f.maxPriorityFeePerGas ?? f.gasPrice;
    if (previous) {
      const bump = (x) => (BigInt(x) * BUMP_NUM) / BUMP_DEN + 1n;
      maxFee = maxFee > bump(previous.maxFeePerGas) ? maxFee : bump(previous.maxFeePerGas);
      tip = tip > bump(previous.maxPriorityFeePerGas) ? tip : bump(previous.maxPriorityFeePerGas);
    }
    const cap = BigInt(cfg.maxFeePerGasWei);
    if (maxFee > cap) maxFee = cap;
    if (tip > maxFee) tip = maxFee;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
  }

  async function sign({ kind, action, claimId, nonce, gasLimit, previous }) {
    const f = await fees(previous);
    const request = kind === 'cancel'
      ? { to: address, data: '0x', value: 0n, gasLimit: 21000n }
      : { to: chain.address, data: callData(action, claimId), value: 0n, gasLimit: BigInt(gasLimit) };
    const raw = await wallet.signTransaction({ type: 2, chainId: chain.chainId, nonce, ...request, ...f });
    return { kind, hash: Transaction.from(raw).hash, raw, gasLimit: request.gasLimit.toString(), maxFeePerGas: f.maxFeePerGas.toString(), maxPriorityFeePerGas: f.maxPriorityFeePerGas.toString(), sentAt: now() };
  }

  /**
   * Records the attempt, then broadcasts it: 'sent' (or already known), 'nonce-used' or
   * 'underpriced'. An attempt identical to the newest one recorded is only broadcast again.
   */
  async function broadcast(attempt, inflight) {
    const repeat = inflight.attempts.at(-1)?.hash === attempt.hash;
    if (!repeat) {
      store.transact((s) => {
        s.keeper.inflight = { ...inflight, attempts: [...inflight.attempts, attempt] };
      });
    }
    await hooks.beforeBroadcast?.();
    try {
      await provider.broadcastTransaction(attempt.raw);
      return 'sent';
    } catch (err) {
      const why = broadcastRefusal(err);
      if (why === 'known') return 'sent';
      if (why) return why;
      // The node answered with a refusal (no funds, say): this attempt is not anywhere, so it is
      // forgotten. With no answer (a timeout) it may have been accepted, and stays recorded.
      const refused = err?.code === 'INSUFFICIENT_FUNDS' || err?.error?.code !== undefined || err?.info?.error?.code !== undefined;
      if (refused && !repeat) {
        store.transact((s) => {
          const left = s.keeper.inflight.attempts.filter((a) => a.hash !== attempt.hash);
          s.keeper.inflight = left.length ? { ...s.keeper.inflight, attempts: left } : null;
        });
      }
      throw new KeeperError('BROADCAST_FAILED', rpcText(err).slice(0, 300));
    }
  }

  function finish(inflight, status, receipt) {
    const attempt = receipt ? inflight.attempts.find((a) => a.hash === receipt.hash) : null;
    const last = {
      action: attempt?.kind === 'cancel' ? 'cancel' : inflight.action,
      claimId: inflight.claimId,
      nonce: inflight.nonce,
      status,
      txHash: receipt?.hash ?? null,
      blockNumber: receipt?.blockNumber ?? null,
      at: now(),
    };
    store.transact((s) => {
      s.keeper.inflight = null;
      s.keeper.last = last;
    });
    if (status === 'reverted') logger.warn(`keeper: ${last.action}(${last.claimId}) reverted in ${last.txHash}`);
    return last;
  }

  /** Waits up to SA_KEEPER_TX_TIMEOUT_MS for the nonce to be used: 'done' or 'pending'. */
  async function settleInflight(inflight, timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const used = (await provider.getTransactionCount(address, 'latest')) > inflight.nonce;
      for (const a of [...inflight.attempts].reverse()) {
        const rc = await provider.getTransactionReceipt(a.hash);
        if (rc) {
          finish(inflight, rc.status === 1 ? 'mined' : 'reverted', rc);
          return 'done';
        }
      }
      if (used) {
        finish(inflight, 'superseded', null); // another transaction of this key took the nonce
        return 'done';
      }
      if (now() >= deadline) return 'pending';
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
    }
  }

  /** The transaction in flight from an earlier cycle or process, resolved first. */
  async function resolve(inflight, sent) {
    if ((await provider.getTransactionCount(address, 'latest')) > inflight.nonce) return settleInflight(inflight, 0);
    let known = false;
    for (const a of inflight.attempts) {
      if (await provider.getTransaction(a.hash)) known = true;
    }
    const newest = inflight.attempts.at(-1);
    if (known && now() - newest.sentAt < cfg.replaceAfterMs) return settleInflight(inflight, cfg.txTimeoutMs);
    const due = await isDue(inflight.action, inflight.claimId);
    if (!due && !known) {
      finish(inflight, 'dropped', null); // nothing of ours is pending, and nothing is due
      return 'done';
    }
    const attempt = await sign({ kind: due ? 'call' : 'cancel', action: inflight.action, claimId: inflight.claimId, nonce: inflight.nonce, gasLimit: newest.gasLimit, previous: newest });
    const result = await broadcast(attempt, inflight);
    if (result !== 'sent') return 'pending'; // the nonce moved, or the node keeps the earlier attempt: next cycle
    sent.push({ action: due ? inflight.action : 'cancel', claimId: inflight.claimId, nonce: inflight.nonce, txHash: attempt.hash, replaced: true });
    return settleInflight(store.state.keeper.inflight, cfg.txTimeoutMs);
  }

  async function sendNew(action, claimId, sent) {
    const data = callData(action, claimId);
    const nonce = await provider.getTransactionCount(address, 'latest');
    let estimate;
    try {
      estimate = await provider.estimateGas(tx(chain.address, data));
    } catch {
      return 'skipped'; // the call stopped passing since it was checked (another sender's is pending, say)
    }
    const gasLimit = (estimate * 5n) / 4n + 10000n;
    const inflight = { action, claimId, nonce, recordedAt: now(), attempts: [] };
    const attempt = await sign({ kind: 'call', action, claimId, nonce, gasLimit });
    const result = await broadcast(attempt, inflight);
    if (result !== 'sent') {
      // another transaction of this key holds the nonce: forget ours and look again next cycle
      store.transact((s) => {
        s.keeper.inflight = null;
      });
      return 'busy';
    }
    sent.push({ action, claimId, nonce, txHash: attempt.hash, replaced: false });
    return settleInflight(store.state.keeper.inflight, cfg.txTimeoutMs);
  }

  function candidates() {
    const wanted = new Set(['Revealed', 'Disputed', 'Judged', ...(cfg.expire ? ['Committed', 'RoundFailed'] : [])]);
    return [...projection().claims.values()]
      .filter((c) => wanted.has(c.state))
      .map((c) => c.claimId)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  }

  /**
   * One cycle: resolve the transaction in flight, then one due call per claim, one at a time.
   * @returns {Promise<{ sent: object[], pending: object|null }>}
   */
  async function run() {
    if (running) return { sent: [], pending: store.state.keeper.inflight };
    running = true;
    const sent = [];
    try {
      const acted = new Set();
      const inflight = store.state.keeper.inflight;
      if (inflight) {
        acted.add(inflight.claimId);
        if ((await resolve(inflight, sent)) === 'pending') return { sent, pending: store.state.keeper.inflight };
      }
      for (const claimId of candidates()) {
        if (acted.has(claimId)) continue;
        const action = await dueAction(claimId);
        if (!action) continue;
        acted.add(claimId);
        const result = await sendNew(action, claimId, sent);
        if (result === 'skipped') continue;
        if (result !== 'done') return { sent, pending: store.state.keeper.inflight };
      }
      return { sent, pending: null };
    } finally {
      running = false;
    }
  }

  return { address, run };
}
