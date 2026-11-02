// Pinning the listing's two archives (node P4a), behind config (src/config.js, SA_PINNING):
//
//   mock      an in-memory, content-addressed store (development and tests; refused in production)
//   kubo      a kubo daemon's RPC API, POST /api/v0/add (a local node in development)
//   filebase  Filebase's IPFS RPC API, the same call with a bearer token from SA_FILEBASE_TOKEN
//   pinata    Pinata's POST /pinning/pinFileToIPFS with the JWT from SA_PINATA_JWT
//
// A credential is read from the environment when a pin is made, never stored in the config and
// never written into an error, a log line or a response. Uploads ask for CIDv1 with raw leaves;
// an answer in the raw sha2-256 form (bafkrei..., what one block of bytes gets) must be the CID
// of the bytes sent, so a service cannot pin something other than the archive under its CID.
import { isRawSha256Cid, rawCid } from './cid.js';

export { rawCid } from './cid.js';

export const BACKENDS = Object.freeze(['mock', 'kubo', 'filebase', 'pinata']);
// StakeAttestation._isValidCid: alphanumeric, 46 to 100 characters.
const STORABLE_CID = /^[0-9A-Za-z]{46,100}$/;

export class PinError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'PinError';
    this.code = code;
    this.detail = detail;
  }
}

function checkedCid(cid, bytes, backend) {
  if (typeof cid !== 'string' || !STORABLE_CID.test(cid)) throw new PinError('PIN_BAD_CID', `${backend} answered no CID the contract can store`);
  if (isRawSha256Cid(cid) && cid !== rawCid(bytes)) throw new PinError('PIN_CID_MISMATCH', `${backend} answered ${cid}, which is not the CID of the bytes sent`);
  return cid;
}

/** The in-memory store: content-addressed by rawCid, every pin kept in order. */
export function createMockPinner() {
  const store = new Map();
  const pins = [];
  return {
    backend: 'mock',
    pins,
    get: (cid) => store.get(cid) ?? null,
    async pin(bytes, { name } = {}) {
      const copy = Buffer.from(bytes);
      const cid = rawCid(copy);
      store.set(cid, copy);
      pins.push({ cid, name: name ?? null, bytes: copy });
      return cid;
    },
  };
}

function credential(env, name) {
  if (!name) return null;
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new PinError('PIN_CREDENTIAL_MISSING', `the environment variable ${name} holds no credential`);
  return value.trim();
}

async function post({ fetch, url, form, token, timeoutMs, backend }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: form,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new PinError('PIN_FAILED', `${backend} could not be reached (${err?.name === 'TimeoutError' ? 'timed out' : 'connection failed'})`);
  }
  // The body is read but never quoted: a service may echo the request's credential in an error.
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new PinError('PIN_FAILED', `${backend} answered HTTP ${res.status}`);
  return text;
}

function kuboPinner({ backend, url, tokenEnv, timeoutMs }, { env, fetch }) {
  const endpoint = new URL('/api/v0/add', url);
  for (const [k, v] of Object.entries({ pin: 'true', 'cid-version': '1', 'raw-leaves': 'true', hash: 'sha2-256', quieter: 'true' })) endpoint.searchParams.set(k, v);
  return {
    backend,
    async pin(bytes, { name = 'archive.zip' } = {}) {
      const token = credential(env, tokenEnv);
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/zip' }), name);
      const text = await post({ fetch, url: endpoint, form, token, timeoutMs, backend });
      const last = text.trim().split('\n').filter(Boolean).pop();
      let answer;
      try {
        answer = JSON.parse(last);
      } catch {
        throw new PinError('PIN_FAILED', `${backend} answered something other than JSON`);
      }
      return checkedCid(answer?.Hash, bytes, backend);
    },
  };
}

function pinataPinner({ url, tokenEnv, timeoutMs }, { env, fetch }) {
  const endpoint = new URL('/pinning/pinFileToIPFS', url);
  return {
    backend: 'pinata',
    async pin(bytes, { name = 'archive.zip' } = {}) {
      const token = credential(env, tokenEnv);
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/zip' }), name);
      form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
      form.append('pinataMetadata', JSON.stringify({ name }));
      const text = await post({ fetch, url: endpoint, form, token, timeoutMs, backend: 'pinata' });
      let answer;
      try {
        answer = JSON.parse(text);
      } catch {
        throw new PinError('PIN_FAILED', 'pinata answered something other than JSON');
      }
      return checkedCid(answer?.IpfsHash, bytes, 'pinata');
    },
  };
}

/**
 * @param {{ backend: string, url?: string, tokenEnv?: string|null, timeoutMs?: number }} cfg - config.pinning
 * @param {{ env?: Record<string, string|undefined>, fetch?: typeof fetch }} [o] - where credentials are read; the HTTP client
 * @returns {{ backend: string, pin(bytes: Buffer, o?: { name?: string }): Promise<string> }}
 */
export function createPinner(cfg, { env = process.env, fetch = globalThis.fetch } = {}) {
  switch (cfg.backend) {
    case 'mock':
      return createMockPinner();
    case 'kubo':
    case 'filebase':
      return kuboPinner(cfg, { env, fetch });
    case 'pinata':
      return pinataPinner(cfg, { env, fetch });
    default:
      throw new TypeError(`unknown pinning backend ${cfg.backend}; known: ${BACKENDS.join(', ')}`);
  }
}
