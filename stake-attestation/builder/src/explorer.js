// A block explorer's contract API in the Etherscan v2 shape (also served by Blockscout):
// `module=contract&action=getsourcecode` for the verified source of an address, and
// the `proxy` module for its deployed bytecode and a deployment proof's reads. The base URL and the API key come
// from the builder's config (per chain id); the key is sent as `apikey` and never appears in an
// error, a log line or the report.
import { getAddress } from 'ethers';

import { BuilderError } from './errors.js';

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function cut(value, n = 200) {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** solc's optimizer runs: an omitted value is the compiler's default, 200; an explicit 0 stays 0. */
export function optimizerRuns(value) {
  if (value === undefined || value === null || value === '') return 200;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 200;
}

/** A source unit list: { path: content }. */
function sourcesOf(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [p, v] of Object.entries(obj)) {
    if (!v || typeof v.content !== 'string') return null;
    out[p] = v.content;
  }
  return out;
}

/**
 * Normalizes a getsourcecode answer: whether the address is verified, the source in one of the
 * three forms Etherscan returns (standard JSON input wrapped in an extra pair of braces, a
 * multi-file object, or one flattened file), the compiler and its settings, and proxy flags.
 * @param {object} json
 */
export function parseSourceResult(json) {
  if (!json || json.status !== '1' || !Array.isArray(json.result) || !json.result[0] || typeof json.result[0] !== 'object') {
    throw new BuilderError('EXPLORER_UNAVAILABLE', `the explorer did not return a source: ${cut(json?.message)} ${cut(json?.result)}`);
  }
  const r = json.result[0];
  const text = typeof r.SourceCode === 'string' ? r.SourceCode : '';
  const out = {
    verified: text.length > 0,
    format: null,
    sources: null,
    settings: null,
    contractName: typeof r.ContractName === 'string' ? r.ContractName : '',
    contractFile: typeof r.ContractFileName === 'string' && r.ContractFileName ? r.ContractFileName : null,
    compilerVersion: typeof r.CompilerVersion === 'string' ? r.CompilerVersion.replace(/^v/, '') : '',
    optimizer: { enabled: r.OptimizationUsed === '1', runs: optimizerRuns(r.Runs) },
    evmVersion: typeof r.EVMVersion === 'string' && r.EVMVersion && r.EVMVersion.toLowerCase() !== 'default' ? r.EVMVersion.toLowerCase() : null,
    viaIR: false,
    language: r.CompilerType === 'vyper' || /vyper/i.test(String(r.CompilerVersion)) ? 'Vyper' : 'Solidity',
    proxy: r.Proxy === '1',
    implementation: typeof r.Implementation === 'string' && r.Implementation ? r.Implementation : null,
  };
  if (!out.verified) return out;
  const trimmed = text.trim();
  let parsed = null;
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    try { parsed = JSON.parse(trimmed.slice(1, -1)); } catch { parsed = null; }
  } else if (trimmed.startsWith('{')) {
    try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
  }
  if (parsed && parsed.language !== undefined && parsed.sources) {
    out.format = 'standard-json';
    if (typeof parsed.language === 'string') out.language = parsed.language;
    out.sources = sourcesOf(parsed.sources);
    out.settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
    if (out.settings.optimizer) {
      out.optimizer = { enabled: out.settings.optimizer.enabled === true, runs: optimizerRuns(out.settings.optimizer.runs) };
    }
    if (typeof out.settings.evmVersion === 'string') out.evmVersion = out.settings.evmVersion.toLowerCase();
    out.viaIR = out.settings.viaIR === true;
  } else if (parsed && sourcesOf(parsed)) {
    out.format = 'multi-file';
    out.sources = sourcesOf(parsed);
  } else {
    out.format = 'flattened';
  }
  if ((out.format === 'standard-json' || out.format === 'multi-file') && !out.sources) {
    throw new BuilderError('EXPLORER_UNAVAILABLE', 'the explorer\'s source files could not be read');
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.apiUrl
 * @param {string|null} o.apiKey
 * @param {number} o.chainId
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.timeoutMs]
 */
export function createExplorer({ apiUrl, apiKey = null, chainId, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  const redact = (s) => (apiKey ? String(s).split(apiKey).join('[redacted]') : String(s));

  async function call(params, what) {
    const u = new URL(apiUrl);
    u.searchParams.set('chainid', String(chainId));
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (apiKey) u.searchParams.set('apikey', apiKey);
    let res;
    let text;
    try {
      res = await fetchImpl(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_RESPONSE_BYTES) throw new Error(`the answer is larger than ${MAX_RESPONSE_BYTES} bytes`);
      text = buf.toString('utf8');
    } catch (err) {
      throw new BuilderError('EXPLORER_UNAVAILABLE', redact(`${what}: ${err.message}`));
    }
    if (!res.ok) throw new BuilderError('EXPLORER_UNAVAILABLE', `${what}: HTTP ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new BuilderError('EXPLORER_UNAVAILABLE', `${what}: the answer is not JSON`);
    }
  }

  return {
    chainId,
    async getSource(address) {
      const json = await call({ module: 'contract', action: 'getsourcecode', address }, `getsourcecode ${address}`);
      try {
        return parseSourceResult(json);
      } catch (err) {
        throw new BuilderError(err.code || 'EXPLORER_UNAVAILABLE', redact(err.detail || err.message));
      }
    },
    async getCode(address) {
      const json = await call({ module: 'proxy', action: 'eth_getCode', address, tag: 'latest' }, `eth_getCode ${address}`);
      if (!json || typeof json.result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(json.result)) {
        throw new BuilderError('EXPLORER_UNAVAILABLE', redact(`eth_getCode ${address}: ${cut(json?.error?.message ?? json?.message)} ${cut(json?.result)}`));
      }
      return json.result.toLowerCase();
    },
    /**
     * A JSON-RPC read through the explorer's proxy module: its `result`, null included.
     * @throws {Error} code CALL_EXCEPTION for a call that reverted
     * @throws {BuilderError} EXPLORER_UNAVAILABLE for anything else that is no answer
     */
    async proxy(action, params = {}) {
      const json = await call({ module: 'proxy', action, ...params }, action);
      if (json?.error) {
        if (/revert/i.test(String(json.error.message))) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
        throw new BuilderError('EXPLORER_UNAVAILABLE', redact(`${action}: ${cut(json.error.message)}`));
      }
      if (!json || !Object.hasOwn(json, 'result') || json.status === '0') {
        throw new BuilderError('EXPLORER_UNAVAILABLE', redact(`${action}: ${cut(json?.message)} ${cut(json?.result)}`));
      }
      return json.result;
    },
  };
}

const hexTag = (tag) => (typeof tag === 'number' ? `0x${tag.toString(16)}` : tag ?? 'latest');
const addressOf = (a) => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? getAddress(a.toLowerCase()) : null);

/**
 * The listing's chain as a deployment proof reads it (shared/src/controlProof.js), through the
 * explorer configured for that chain, in the form ethers' provider gives: an explorer's answers are
 * plain JSON-RPC, with hex numbers and lowercase addresses. The chain id is the explorer's own: it
 * is configured per chain, and the v2 API takes it as a parameter.
 */
export function explorerChain(explorer) {
  return {
    send: async (method) => {
      if (method !== 'eth_chainId') throw new TypeError(`no ${method} through the explorer`);
      return `0x${explorer.chainId.toString(16)}`;
    },
    getBlockNumber: async () => Number(await explorer.proxy('eth_blockNumber')),
    getCode: (address, tag) => explorer.proxy('eth_getCode', { address, tag: hexTag(tag) }),
    call: ({ to, data, blockTag }) => explorer.proxy('eth_call', { to, data, tag: hexTag(blockTag) }),
    getTransaction: async (hash) => {
      const tx = await explorer.proxy('eth_getTransactionByHash', { txhash: hash });
      return tx ? { from: addressOf(tx.from) } : null;
    },
    getTransactionReceipt: async (hash) => {
      const rc = await explorer.proxy('eth_getTransactionReceipt', { txhash: hash });
      return rc ? { status: Number(rc.status), blockNumber: Number(rc.blockNumber), contractAddress: addressOf(rc.contractAddress) } : null;
    },
  };
}
