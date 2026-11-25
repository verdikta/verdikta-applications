// Wallet sign-in for what only one address may do or read (node P4b2: the maker's baseline scan;
// other routes may use the same check). The server issues a one-time challenge naming an action,
// a resource and the address that must sign; the wallet signs the challenge's message exactly as
// given, with EIP-191 personal_sign (ethers signer.signMessage, eth personal_sign); the server
// rebuilds the message from its own copy of the challenge, never from the request, and recovers
// the signer with ethers' verifyMessage.
//
// The message, ASCII, one field per line, joined with "\n" and no final newline:
//
//   Verdikta stake attestation: sign in
//   <the action's statement> This is not a transaction: it costs nothing and moves no funds.
//
//   Version: 1
//   Action: <action>                  read-scan, pin-dispute, list-version
//   Resource: <resource>              listing:<the listing's 32-hex id>, claim:<the claim's id>,
//                                     list-request:<the request's SHA-256>
//   Address: <EIP-55 address>         the address that must sign
//   Nonce: <32 lowercase hex>         its issue time, random bits and the server's MAC (createWalletAuth)
//   Issued At: <UTC, ISO 8601, whole seconds, Z>
//   Expiration Time: <the same form>  Issued At + the challenge's lifetime
//
// A nonce answers one attempt, whatever its outcome, and nothing after its expiry. Challenges take no
// room until answered (createWalletAuth), so no one can use up another wallet's sign-in by asking for them. Only ECDSA
// signatures from externally owned accounts are checked (no EIP-1271 contract wallets).
import crypto from 'node:crypto';
import { getAddress, isAddress, verifyMessage } from 'ethers';
import { AUTH_ACTIONS, AUTH_MESSAGE_VERSION, AUTH_TITLE, authMessageText } from '@verdikta/stake-attestation-shared/auth-message';

export { AUTH_ACTIONS, AUTH_MESSAGE_VERSION, AUTH_TITLE };

const ACTION = /^[a-z][a-z-]{0,31}$/;
const RESOURCE = /^[a-z][a-z-]{0,31}:[0-9A-Za-z._-]{1,128}$/;
const NONCE = /^[0-9a-f]{32}$/;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;
const ZERO = '0x0000000000000000000000000000000000000000';

export class AuthError extends Error {
  constructor(status, code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.[0-9]{3}Z$/, 'Z');

function checkedAddress(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || !isAddress(address.toLowerCase())) throw new TypeError('the address is not a 20-byte 0x address');
  const a = getAddress(address.toLowerCase());
  if (a === ZERO) throw new TypeError('the zero address cannot sign');
  return a;
}

function checkedTarget(action, resource) {
  if (typeof action !== 'string' || !ACTION.test(action) || !Object.hasOwn(AUTH_ACTIONS, action)) throw new TypeError(`unknown action ${JSON.stringify(action)}; known: ${Object.keys(AUTH_ACTIONS).join(', ')}`);
  if (typeof resource !== 'string' || !RESOURCE.test(resource)) throw new TypeError('a resource is "<kind>:<id>", lowercase kind, id of letters, digits, ".", "_" and "-"');
}

/**
 * The text the wallet signs, in the format above.
 * @throws {TypeError} a field outside its format (so no value can add a line of its own)
 */
export function authMessage({ action, resource, address, nonce, issuedAt, expiresAt }) {
  checkedTarget(action, resource);
  const signer = checkedAddress(address);
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new TypeError('the nonce is 32 lowercase hex digits');
  for (const t of [issuedAt, expiresAt]) if (typeof t !== 'string' || !TIME.test(t)) throw new TypeError('times are UTC ISO 8601 in whole seconds, ending in Z');
  return authMessageText({ action, resource, address: signer, nonce, issuedAt, expiresAt });
}

const refuse = (status, code, detail) => ({ ok: false, status, code, detail });

/** 32 bits of the server's HMAC over the fields, as 8 hex digits. */
function tag(key, ...fields) {
  return crypto.createHmac('sha256', key).update(fields.join('\n')).digest().subarray(0, 4).toString('hex');
}
const sameHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/**
 * The sign-in's challenges. They hold no state until they are answered: the nonce carries its own issue time
 * and the server's MAC over the action, resource and address it was issued for, so whoever asks for challenges,
 * as many as they like, takes no room from anyone (a hunter could otherwise keep a listing's maker from ever
 * getting the challenge for a dispute statement in its window). The nonce, 32 hex digits:
 *
 *   issued (8: whole seconds) | random (8) | MAC of issued and random (8) | MAC of those and the target (8)
 *
 * Only answered nonces are kept, each until its challenge expires, so a nonce still answers once.
 * @param {object} [o]
 * @param {number} [o.ttlMs] - a challenge's lifetime (300000, five minutes)
 * @param {number} [o.maxUsed] - answered nonces kept until their expiry (100000); past it the oldest go first
 * @param {() => number} [o.now] - the clock, in ms
 * @param {Buffer} [o.key] - the MAC key (random, per process: a restart ends every open challenge)
 */
export function createWalletAuth({ ttlMs = 300000, maxUsed = 100000, now = Date.now, key = crypto.randomBytes(32) } = {}) {
  /** nonce -> when its challenge expires, in ms */
  const used = new Map();

  function prune(t) {
    for (const [nonce, expiresAtMs] of used) if (t > expiresAtMs) used.delete(nonce);
    while (used.size > maxUsed) used.delete(used.keys().next().value);
  }

  const timesOf = (issuedSec) => {
    const issuedMs = issuedSec * 1000;
    return { issuedAt: iso(issuedMs), expiresAt: iso(issuedMs + ttlMs), expiresAtMs: issuedMs + ttlMs };
  };

  return {
    ttlMs,
    /**
     * @returns {{ action: string, resource: string, address: string, nonce: string, issuedAt: string, expiresAt: string, message: string }}
     * @throws {TypeError} an unknown action, a malformed resource, an address that cannot sign
     */
    challenge({ action, resource, address }) {
      checkedTarget(action, resource);
      const signer = checkedAddress(address);
      // whole seconds, so the expiry the message states is the one enforced
      const issuedSec = Math.floor(now() / 1000);
      const head = `${issuedSec.toString(16).padStart(8, '0')}${crypto.randomBytes(4).toString('hex')}`;
      const ours = tag(key, 'issued', head);
      const nonce = `${head}${ours}${tag(key, 'target', head, ours, action, resource, signer)}`;
      const { issuedAt, expiresAt } = timesOf(issuedSec);
      const c = { action, resource, address: signer, nonce, issuedAt, expiresAt };
      c.message = authMessage(c);
      return c;
    },

    /**
     * Checks a signed challenge for `action` on `resource`, which `address` must sign. The nonce is used up by
     * any attempt that names it.
     * @returns {{ ok: true, address: string, issuedAt: string, expiresAt: string } | { ok: false, status: 400|401|403, code: string, detail: string }}
     */
    verify({ action, resource, address, nonce, signature } = {}) {
      const malformed = () => refuse(400, 'AUTH_REQUEST_INVALID', 'send { nonce, signature }: the challenge\'s nonce and the wallet\'s signature of its message, as 0x hex');
      if (typeof nonce !== 'string' || !NONCE.test(nonce)) return malformed();
      const t = now();
      prune(t);
      const head = nonce.slice(0, 16);
      const ours = nonce.slice(16, 24);
      const unknown = () => refuse(401, 'CHALLENGE_UNKNOWN', 'no open challenge has this nonce: it was answered already, it expired, or it was never issued; ask for a new one');
      const issued = sameHex(ours, tag(key, 'issued', head));
      const open = issued && !used.has(nonce);
      const times = timesOf(Number.parseInt(nonce.slice(0, 8), 16));
      // an attempt that names a challenge this server issued uses it up, whatever else is wrong with it
      if (issued) used.set(nonce, times.expiresAtMs);
      if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return malformed();
      if (!open) return unknown();
      if (t > times.expiresAtMs) return refuse(401, 'CHALLENGE_EXPIRED', `the challenge expired at ${times.expiresAt}; ask for a new one`);
      let signer;
      try {
        checkedTarget(action, resource);
        signer = checkedAddress(address);
      } catch {
        signer = null;
      }
      if (!signer || !sameHex(nonce.slice(24), tag(key, 'target', head, ours, action, resource, signer))) return refuse(401, 'CHALLENGE_MISMATCH', 'the challenge was issued for another action or resource');
      const message = authMessageText({ action, resource, address: signer, nonce, issuedAt: times.issuedAt, expiresAt: times.expiresAt });
      let recovered;
      try {
        recovered = verifyMessage(message, signature);
      } catch {
        return refuse(401, 'SIGNATURE_INVALID', 'the signature is not a valid signature of the challenge\'s message');
      }
      if (recovered !== signer) return refuse(403, 'WRONG_ADDRESS', `the message is signed by ${recovered}, not by ${signer}`);
      return { ok: true, address: signer, issuedAt: times.issuedAt, expiresAt: times.expiresAt };
    },
  };
}
