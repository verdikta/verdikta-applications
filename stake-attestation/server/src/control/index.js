// The control facts' side of the site (node P8): the git check and the deployment proofs, run beside
// the indexer and the keeper and never inside them (the lesson of P4b1's archive reads). One run at
// a time, started by each sync and never awaited by it, at most MAX_CHECKS_PER_RUN repositories and
// MAX_PROOFS_PER_RUN proofs a run, each bounded in time; a failure is stored with its next attempt,
// counted from when it failed and doubling per failure. Until an answer is in, and after any failed
// check, the fact is "no". Answers are stored by what they are about (facts.js), so a reorg that
// moves a listing id cannot hand one listing's "yes" to another, and they are read with the state
// snapshot of the answer that shows them.
import { FetchRequest, JsonRpcProvider, Network } from 'ethers';

import { CONTROL_REASONS, canonicalAddress, controlFact, controlMessage, deploymentKey, parseControlFile, repoKey, repoUrlCheck } from './facts.js';
import { ChainReadError, checkDeploymentProof } from './deployment.js';

const MAX_CHECKS_PER_RUN = 4;
const MAX_PROOFS_PER_RUN = 8;
// Proof checks whose reads have not all settled, sent or background alike. A check past its deadline
// keeps its place until its read in flight settles (ethers gives one up within its own limit), and
// makes no further read.
const MAX_PROOF_CHECKS_AT_ONCE = 4;
const RETRY_MAX_MS = 6 * 3600_000;
const EMPTY = Object.freeze({ repositories: Object.freeze({}), deployments: Object.freeze({}) });
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){1,4096}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;
const LISTING_ID = /^[1-9][0-9]{0,30}$/;

export class ControlError extends Error {
  constructor(code, detail, status) {
    super(`${code}: ${detail}`);
    this.name = 'ControlError';
    this.code = code;
    this.status = status;
  }
}

/** The answers in a state snapshot; a state file from before this node has none. */
export const controlOf = (state) => state.control ?? EMPTY;

/**
 * @param {object} o
 * @param {object} o.config - loadConfig()
 * @param {import('../site/store.js').StateStore} o.store
 * @param {import('ethers').JsonRpcApiProvider} o.provider - the site's chain
 * @param {Record<string, string|undefined>} o.env - where another chain's RPC URL is read
 * @param {() => number} o.now
 * @param {object} o.logger
 * @param {(o: { repo: string, commit: string }) => Promise<object>} o.checkRepository
 * @param {(chainId: number) => object|null} [o.chainProviderFor] - a provider on that chain, or null
 */
export function createControl({ config, store, provider, env, now, logger, checkRepository, chainProviderFor }) {
  const cfg = config.control;
  const stake = { chainId: config.chain.chainId, address: config.chain.address };
  const backoff = (attempts) => Math.min(RETRY_MAX_MS, cfg.retryMs * 2 ** (attempts - 1));
  let proofChecks = 0;

  const otherChains = new Map();
  const defaultProviderFor = (chainId) => {
    if (chainId === stake.chainId) return provider;
    if (otherChains.has(chainId)) return otherChains.get(chainId);
    const url = env[`SA_CONTROL_RPC_URL_${chainId}`];
    let p = null;
    if (typeof url === 'string' && url.trim()) {
      const network = Network.from(chainId);
      const request = new FetchRequest(url.trim());
      request.timeout = cfg.rpcTimeoutMs;
      p = new JsonRpcProvider(request, network, { staticNetwork: network, cacheTimeout: -1 });
    }
    otherChains.set(chainId, p);
    return p;
  };
  const providerFor = chainProviderFor ?? defaultProviderFor;

  /** The reads a check makes, none of them once it has expired. */
  function guardedReads(chain) {
    let expired = false;
    const read = (fn) => {
      if (expired) throw new ChainReadError('CHAIN_UNAVAILABLE', 'past its deadline');
      return fn();
    };
    return {
      expire: () => { expired = true; },
      reads: {
        send: (method, params) => read(() => chain.send(method, params)),
        getBlockNumber: () => read(() => chain.getBlockNumber()),
        getCode: (address, blockTag) => read(() => chain.getCode(address, blockTag)),
        call: (tx) => read(() => chain.call(tx)),
        getTransaction: (hash) => read(() => chain.getTransaction(hash)),
        getTransactionReceipt: (hash) => read(() => chain.getTransactionReceipt(hash)),
      },
    };
  }

  /** `work`'s answer, or at the deadline CHAIN_UNAVAILABLE, with `expire` called so it reads no more. */
  function withDeadline(work, expire) {
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expire();
        reject(new ChainReadError('CHAIN_UNAVAILABLE', `no answer in ${cfg.rpcTimeoutMs} ms`));
      }, cfg.rpcTimeoutMs);
    });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }

  /** One proof, on the listing's chain: its answer, with a reason a fact can state. */
  async function proofAnswer(listing, proof) {
    const { artifact, maker, artifactHash } = listing;
    const chainId = Number(artifact.chainId);
    const chain = Number.isSafeInteger(chainId) ? providerFor(chainId) : null;
    if (!chain) return { ok: false, reason: 'CHAIN_NOT_CHECKED', transient: false };
    try {
      const message = controlMessage({ maker, artifactHash, chainId: artifact.chainId, address: artifact.address, stakeChainId: stake.chainId, stakeContract: stake.address });
      const { reads, expire } = guardedReads(chain);
      proofChecks += 1;
      const work = checkDeploymentProof(reads, { message, chainId: artifact.chainId, address: artifact.address, ...proof }).finally(() => { proofChecks -= 1; });
      return { ...await withDeadline(work, expire), transient: false };
    } catch (err) {
      if (err instanceof ChainReadError && err.code === 'CHAIN_NOT_CHECKED') return { ok: false, reason: 'CHAIN_NOT_CHECKED', transient: false };
      logger.warn(`control: chain ${artifact.chainId} could not be read (${err?.code ?? err?.name ?? 'error'})`);
      return { ok: false, reason: 'CHAIN_UNAVAILABLE', transient: true };
    }
  }

  function putRepository(key, entry) {
    store.transact((s) => {
      s.control ??= { repositories: {}, deployments: {} };
      s.control.repositories[key] = entry;
    });
  }

  /** `update` of the proof on file, if that is still the proof `rev` says: one sent meanwhile stands. */
  function updateDeployment(key, rev, update) {
    store.transact((s) => {
      const current = s.control?.deployments?.[key];
      if (current && current.rev === rev) s.control.deployments[key] = update(current);
    });
  }

  async function checkOne({ key, repo, commit, known }) {
    const t = () => now();
    let entry;
    try {
      const a = await checkRepository({ repo, commit });
      let file = null;
      if (a.file) {
        const parsed = a.file.problem || a.file.text === null ? { maker: null, problem: a.file.problem ?? 'NOT_JSON' } : parseControlFile(a.file.text);
        file = { blob: a.file.blob, named: parsed.maker, problem: parsed.problem };
      }
      entry = { reachable: a.reachable, ref: a.ref, file, error: null, attempts: 0, checkedAt: t(), nextAt: t() + cfg.recheckMs };
    } catch (err) {
      const attempts = (known?.attempts ?? 0) + 1;
      const error = err?.code === 'REPO_TOO_LARGE' ? 'REPO_TOO_LARGE' : 'REPO_UNAVAILABLE';
      entry = { error, attempts, checkedAt: t(), nextAt: t() + backoff(attempts) };
      logger.warn(`control: ${repo} at ${commit} gave no answer (${error}); next try in ${Math.round(backoff(attempts) / 1000)} s`);
    }
    if (store.locked) putRepository(key, entry); // the site may have closed while this check ran
  }

  async function checkProof(item) {
    const { key, listing, entry } = item;
    const r = await proofAnswer(listing, { signer: entry.signer, signature: entry.signature, creationTx: entry.creationTx ?? null });
    if (!store.locked) return;
    const t = now();
    updateDeployment(key, entry.rev, (current) => {
      if (r.ok) return { ...current, ok: true, reason: null, role: r.role, contractSigner: r.contractSigner, block: r.block, attempts: 0, checkedAt: t, nextAt: t + cfg.recheckMs };
      const attempts = r.transient ? (current.attempts ?? 0) + 1 : 0;
      return { ...current, ok: false, reason: r.reason, role: null, contractSigner: null, block: null, attempts, checkedAt: t, nextAt: t + (r.transient ? backoff(attempts) : cfg.recheckMs) };
    });
  }

  return {
    /**
     * One run: the repositories and proofs that are due, of the opened listings given. A listing
     * that ended keeps its last answer; one never answered is still checked.
     * @param {object[]} listings - the projection's listings
     */
    async refresh(listings) {
      const t = now();
      const repos = new Map();
      for (const l of listings) {
        if (!l.opened || !repoUrlCheck(l.artifact.repo, cfg.gitHosts).ok) continue;
        const key = repoKey(l.artifact);
        const live = !l.rolled && !l.closed;
        const seen = repos.get(key);
        repos.set(key, { key, repo: l.artifact.repo, commit: l.artifact.baseCommit, live: live || Boolean(seen?.live) });
      }
      const { repositories, deployments } = controlOf(store.state);
      const due = [];
      for (const item of repos.values()) {
        const known = repositories[item.key];
        if (!known || (known.nextAt <= t && (item.live || known.error))) due.push({ ...item, known });
      }
      due.sort((a, b) => (a.known?.nextAt ?? 0) - (b.known?.nextAt ?? 0));
      for (const item of due.slice(0, MAX_CHECKS_PER_RUN)) {
        if (!store.locked) return;
        await checkOne(item);
      }

      const proofs = [];
      for (const l of listings) {
        if (!l.opened || l.artifact.kind !== 'Contract') continue;
        const key = deploymentKey(l.artifactHash, l.maker);
        const entry = deployments[key];
        if (entry && entry.nextAt <= t && !l.rolled && !l.closed && !proofs.some((p) => p.key === key)) proofs.push({ key, listing: l, entry });
      }
      for (const item of proofs.slice(0, MAX_PROOFS_PER_RUN)) {
        if (!store.locked || proofChecks >= MAX_PROOF_CHECKS_AT_ONCE) return; // the next run takes it
        await checkProof(item);
      }
    },

    /** A listing's fact from a state snapshot. */
    factOf(state, { artifactHash, maker, artifact }) {
      return controlFact({ control: controlOf(state), artifactHash, maker, artifact: artifact ?? null, hosts: cfg.gitHosts, stake });
    },

    /**
     * A signature sent for a contract listing: checked now, stored only if valid. Anyone may send
     * one, since it speaks for itself; a refused one never takes away what is on file.
     * @param {object} listing - the projection's listing (with artifactHash and maker)
     * @param {{ signer?: unknown, signature?: unknown, creationTx?: unknown }} body
     * @throws {ControlError}
     */
    async submit(listing, body) {
      if (listing.artifact.kind !== 'Contract') throw new ControlError('NOT_A_CONTRACT_LISTING', 'a repository listing proves control with a file at its commit', 409);
      const o = body && typeof body === 'object' ? body : {};
      const signer = canonicalAddress(o.signer);
      if (!signer) throw new ControlError('BAD_SIGNER', 'signer is an EIP-55 or all-lowercase 0x address', 400);
      if (typeof o.signature !== 'string' || !SIGNATURE.test(o.signature)) throw new ControlError('BAD_SIGNATURE', 'signature is 0x hex, at most 4,096 bytes', 400);
      const creationTx = o.creationTx ?? null;
      if (creationTx !== null && (typeof creationTx !== 'string' || !TX_HASH.test(creationTx))) throw new ControlError('BAD_CREATION_TX', 'creationTx is the deployment\'s transaction hash, 0x and 64 lowercase hex digits', 400);
      if (proofChecks >= MAX_PROOF_CHECKS_AT_ONCE) throw new ControlError('TOO_MANY_PROOF_CHECKS', 'too many proofs are being checked; try again in a moment', 429);
      const r = await proofAnswer(listing, { signer, signature: o.signature, creationTx });
      if (!r.ok) {
        const status = r.reason === 'CHAIN_NOT_CHECKED' || r.reason === 'CHAIN_UNAVAILABLE' ? 503 : 422;
        throw new ControlError(r.reason, CONTROL_REASONS[r.reason], status);
      }
      const t = now();
      const key = deploymentKey(listing.artifactHash, listing.maker);
      store.transact((s) => {
        s.control ??= { repositories: {}, deployments: {} };
        const rev = (s.control.deployments[key]?.rev ?? 0) + 1;
        s.control.deployments[key] = { rev, signer, signature: o.signature, creationTx, ok: true, reason: null, role: r.role, contractSigner: r.contractSigner, block: r.block, attempts: 0, checkedAt: t, nextAt: t + cfg.recheckMs };
      });
    },

    listingIdValid: (id) => typeof id === 'string' && LISTING_ID.test(id),
  };
}
