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
//   Action: <action>                  read-scan
//   Resource: <resource>              listing:<the listing's 32-hex id>
//   Address: <EIP-55 address>         the address that must sign
//   Nonce: <32 lowercase hex>         16 random bytes, issued once
//   Issued At: <UTC, ISO 8601, whole seconds, Z>
//   Expiration Time: <the same form>  Issued At + the challenge's lifetime
//
// A nonce answers one attempt, whatever its outcome, and nothing after its expiry. Only ECDSA
// signatures from externally owned accounts are checked (no EIP-1271 contract wallets).
import crypto from 'node:crypto';
import { getAddress, isAddress, verifyMessage } from 'ethers';

export const AUTH_MESSAGE_VERSION = 1;
export const AUTH_TITLE = 'Verdikta stake attestation: sign in';
const NOT_A_TRANSACTION = 'This is not a transaction: it costs nothing and moves no funds.';

/** The actions a challenge may name, each with the statement the wallet shows. */
export const AUTH_ACTIONS = Object.freeze({
  'read-scan': 'Sign to read the baseline scan of a listing you made.',
});

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
  return [
    AUTH_TITLE,
    `${AUTH_ACTIONS[action]} ${NOT_A_TRANSACTION}`,
    '',
    `Version: ${AUTH_MESSAGE_VERSION}`,
    `Action: ${action}`,
    `Resource: ${resource}`,
    `Address: ${signer}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join('\n');
}

const refuse = (status, code, detail) => ({ ok: false, status, code, detail });

/**
 * Challenges kept in memory, each until it is answered or expires.
 * @param {object} [o]
 * @param {number} [o.ttlMs] - a challenge's lifetime (300000, five minutes)
 * @param {number} [o.maxOutstanding] - challenges awaiting an answer, in all (10000)
 * @param {number} [o.maxPerResource] - and per resource (32)
 * @param {() => number} [o.now] - the clock, in ms
 */
export function createWalletAuth({ ttlMs = 300000, maxOutstanding = 10000, maxPerResource = 32, now = Date.now } = {}) {
  const open = new Map();

  function prune(t) {
    for (const [nonce, c] of open) if (t > c.expiresAtMs) open.delete(nonce);
  }

  return {
    ttlMs,
    /**
     * @returns {{ action: string, resource: string, address: string, nonce: string, issuedAt: string, expiresAt: string, message: string }}
     * @throws {TypeError} an unknown action, a malformed resource, an address that cannot sign
     * @throws {AuthError} 429 TOO_MANY_CHALLENGES
     */
    challenge({ action, resource, address }) {
      checkedTarget(action, resource);
      const signer = checkedAddress(address);
      const t = now();
      prune(t);
      if (open.size >= maxOutstanding) throw new AuthError(429, 'TOO_MANY_CHALLENGES', 'too many sign-in challenges are waiting for an answer; try again in a few minutes');
      let forResource = 0;
      for (const c of open.values()) if (c.resource === resource) forResource += 1;
      if (forResource >= maxPerResource) throw new AuthError(429, 'TOO_MANY_CHALLENGES', 'too many sign-in challenges for this resource are waiting for an answer; try again in a few minutes');
      // whole seconds, so the expiry the message states is the one enforced
      const issuedMs = Math.floor(t / 1000) * 1000;
      const c = {
        action,
        resource,
        address: signer,
        nonce: crypto.randomBytes(16).toString('hex'),
        issuedAt: iso(issuedMs),
        expiresAt: iso(issuedMs + ttlMs),
      };
      c.message = authMessage(c);
      open.set(c.nonce, { ...c, expiresAtMs: issuedMs + ttlMs });
      return c;
    },

    /**
     * Checks a signed challenge for `action` on `resource`. The nonce is used up by any attempt
     * that names it.
     * @returns {{ ok: true, address: string } | { ok: false, status: 400|401|403, code: string, detail: string }}
     */
    verify({ action, resource, nonce, signature } = {}) {
      const malformed = () => refuse(400, 'AUTH_REQUEST_INVALID', 'send { nonce, signature }: the challenge\'s nonce and the wallet\'s signature of its message, as 0x hex');
      if (typeof nonce !== 'string' || !NONCE.test(nonce)) return malformed();
      // an attempt that names an open challenge uses it up, whatever else is wrong with it
      const c = open.get(nonce);
      open.delete(nonce);
      if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return malformed();
      if (!c) return refuse(401, 'CHALLENGE_UNKNOWN', 'no open challenge has this nonce: it was answered already, it expired, or it was never issued; ask for a new one');
      if (now() > c.expiresAtMs) return refuse(401, 'CHALLENGE_EXPIRED', `the challenge expired at ${c.expiresAt}; ask for a new one`);
      if (c.action !== action || c.resource !== resource) return refuse(401, 'CHALLENGE_MISMATCH', 'the challenge was issued for another action or resource');
      let signer;
      try {
        signer = verifyMessage(c.message, signature);
      } catch {
        return refuse(401, 'SIGNATURE_INVALID', 'the signature is not a valid signature of the challenge\'s message');
      }
      if (signer !== c.address) return refuse(403, 'WRONG_ADDRESS', `the message is signed by ${signer}, not by ${c.address}`);
      return { ok: true, address: signer };
    },
  };
}
