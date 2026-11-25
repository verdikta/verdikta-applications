// Regression tests for the security review fixes: CID validation and signed admin actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { isValidCid } = require('../utils/cid');
const { checkSignedAction } = require('../middleware/adminAuth');
const { isSignatureRecent } = require('../utils/signatureVerification');

const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

test('isValidCid accepts exactly one CID and nothing around it', () => {
  assert.equal(isValidCid(CID_V0), true);
  assert.equal(isValidCid(CID_V1), true);
  for (const bad of [
    `../../../api/v0/x?${CID_V1}`,
    `${CID_V0}/../../evil`,
    `evil.html#${CID_V1}`,
    `${CID_V0}?x=1`,
    `${CID_V1}/`,
    '', null, undefined,
  ]) assert.equal(isValidCid(bad), false, String(bad));
});

// Same text as client/src/utils/signatureUtils.js createSignatureMessage.
function message(action, data, ts) {
  const dataString = Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '';
  return `Verdikta Playground - ${action}\n\n${dataString}\n\nTimestamp: ${ts}\nThis signature authorizes the above action.`;
}

async function signedReq(wallet, action, data, { ts = Date.now(), body = data, params = {} } = {}) {
  const msg = message(action, data, ts);
  const signature = await wallet.signMessage(msg);
  return { body: { ...body, auth: { message: msg, signature, address: wallet.address } }, params };
}

test('a signed admin action is accepted for its own action and data, once', async () => {
  const w = ethers.Wallet.createRandom();
  const req = await signedReq(w, 'Add Administrator', { newAdminAddress: '0x' + '12'.repeat(20) });
  assert.deepEqual(checkSignedAction(req, 'Add Administrator'), { ok: true, address: w.address.toLowerCase() });
  // Replaying the same signature is refused.
  assert.equal(checkSignedAction(req, 'Add Administrator').ok, false);
});

test('a signature does not authorize another action, other data, or another target', async () => {
  const w = ethers.Wallet.createRandom();
  const victim = '0x' + '34'.repeat(20);
  // Signed "Delete Contract" for one address, used for another action.
  const del = await signedReq(w, 'Delete Contract', { target: victim }, { params: { address: victim } });
  assert.match(checkSignedAction(del, 'Add Administrator').error, /not "Add Administrator"/);
  // ...for the same action against a different target.
  const other = await signedReq(w, 'Delete Contract', { target: victim }, { params: { address: '0x' + '56'.repeat(20) } });
  assert.match(checkSignedAction(other, 'Delete Contract', { targetParam: 'address' }).error, /target/);
  // ...with a body other than the one signed.
  const swapped = await signedReq(w, 'Update Contract', { contracts: [{ address: victim, name: 'A' }] },
    { body: { contracts: [{ address: '0x' + '66'.repeat(20), name: 'Evil' }] } });
  assert.match(checkSignedAction(swapped, 'Update Contract').error, /does not match/);
  // An unrelated message that merely carries a "Timestamp:" line.
  const msg = `Sign in to some site\nTimestamp: ${Date.now()}`;
  const loose = { body: { auth: { message: msg, signature: await w.signMessage(msg), address: w.address } } };
  assert.equal(checkSignedAction(loose, 'Add Administrator').ok, false);
});

test('signatures expire on both sides of the window', async () => {
  const w = ethers.Wallet.createRandom();
  const data = { newAdminAddress: '0x' + '78'.repeat(20) };
  const future = await signedReq(w, 'Add Administrator', data, { ts: Date.now() + 10 * 365 * 86400_000 });
  assert.match(checkSignedAction(future, 'Add Administrator').error, /expired/);
  const old = await signedReq(w, 'Add Administrator', data, { ts: Date.now() - 6 * 60_000 });
  assert.match(checkSignedAction(old, 'Add Administrator').error, /expired/);
  assert.equal(isSignatureRecent(`Timestamp: ${Date.now() + 10 * 365 * 86400_000}`), false);
  assert.equal(isSignatureRecent(`Timestamp: ${Date.now()}`), true);
});

test('a forged signer address is refused', async () => {
  const w = ethers.Wallet.createRandom();
  const req = await signedReq(w, 'Add Contract', { address: '0x' + '9a'.repeat(20), name: 'X', network: 'base_sepolia' });
  req.body.auth.address = ethers.Wallet.createRandom().address;
  assert.match(checkSignedAction(req, 'Add Contract').error, /Invalid signature/);
});

test('contract names cannot add lines or fields to client/.env', () => {
  const { sanitizeContractName } = require('../utils/contractsManager');
  assert.equal(sanitizeContractName('Main\nREACT_APP_SERVER_URL=https://evil.example'), 'Main REACT_APP_SERVER_URL=https://evil.example');
  assert.equal(sanitizeContractName('a,b\r\nc'), 'a b c');
  assert.equal(sanitizeContractName('x'.repeat(200)).length, 80);
});
