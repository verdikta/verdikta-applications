/**
 * CID validation for GET /api/fetch/:cid.
 *
 * The CID is put into a gateway URL (`${gateway}/ipfs/${cid}`) by
 * @verdikta/common's IPFSClient, so it must be exactly one CID and nothing
 * else: no "/", "?", "#", ".." or other path. The old pattern was
 * /^Qm..{44}|b..{58}|...|F..{50}$/i, whose ^ and $ bound only the first and the
 * last alternative, so "../../anything?bAAAA…" (an encoded %2F in the route
 * parameter decodes to "/") passed and steered the server's fetch to other
 * paths on the gateway hosts.
 */
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58}|B[A-Z2-7]{58}|z[1-9A-HJ-NP-Za-km-z]{48}|F[0-9A-F]{50})$/i;

function isValidCid(cid) {
  return typeof cid === 'string' && CID_RE.test(cid);
}

module.exports = { isValidCid, CID_RE };
