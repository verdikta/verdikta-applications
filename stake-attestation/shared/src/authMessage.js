// The text a wallet signs to sign in (server/src/auth/walletAuth.js holds the challenges). It lives here because
// the production signing job rebuilds it, field for field, to check that a listing request is the maker's wallet's
// (siteRequest.js). ASCII, one field per line, joined with "\n" and no final newline.

export const AUTH_MESSAGE_VERSION = 1;
export const AUTH_TITLE = 'Verdikta stake attestation: sign in';
const NOT_A_TRANSACTION = 'This is not a transaction: it costs nothing and moves no funds.';

/** The action of a listing request (server/src/listing/service.js). */
export const LIST_ACTION = 'list-version';

/** The actions a challenge may name, each with the statement the wallet shows. */
export const AUTH_ACTIONS = Object.freeze({
  'read-scan': 'Sign to read the baseline scan of a listing you made.',
  // node P6b: the maker's dispute statement, pinned by the server (src/dispute/statement.js)
  'pin-dispute': 'Sign to pin the statement of a dispute you file against a verdict on your listing.',
  // node P9: the listing request names this wallet as its maker (src/listing/service.js)
  [LIST_ACTION]: 'Sign to ask the site to build and sign a listing of a version, with this wallet as its maker.',
});

/** The message, for fields the caller has checked. */
export function authMessageText({ action, resource, address, nonce, issuedAt, expiresAt }) {
  return [
    AUTH_TITLE,
    `${AUTH_ACTIONS[action]} ${NOT_A_TRANSACTION}`,
    '',
    `Version: ${AUTH_MESSAGE_VERSION}`,
    `Action: ${action}`,
    `Resource: ${resource}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join('\n');
}
