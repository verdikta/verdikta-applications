// The v2 aggregator draws a round's jury in a second step: status says the round waits for its draw, and claim sends
// drawJury (through StakeAttestation, so the claim's wallet is the drawer and earns the reward) once its dry run passes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { closeRpc, runCli } from './helpers/cli.js';
import { makeClaimDir, makeWorld } from './helpers/world.js';

let w;
before(async () => { w = await makeWorld(); });
after(async () => {
  await closeRpc(w);
  await w.close();
});

test('v2: a round still to be drawn waits for its draw; claim draws it through the contract, the reward the wallet\'s', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const { claimId } = await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  await w.hunter().reveal({ claimDir: dir, acknowledge: true });
  const { requestId } = await w.sa.getClaim(claimId);
  await w.mine(2);
  const s = await w.hunter({ signer: undefined }).status({ claimDir: dir });
  assert.equal(s.state, 'Revealed');
  assert.equal(s.pending, true);
  assert.equal(s.ready, 'draw');
  assert.equal(s.round.phase, 1n);
  assert.equal(s.round.deadline, 0n);
  assert.match(s.next, /still open, and its jury is not drawn yet/);
  assert.match(s.next, /run claim to draw it/);
  assert.match(s.next, /never times out/);
  const text = await runCli(w, ['status', dir], { keyVia: 'none' });
  assert.match(text.stdout, /its jury not drawn yet/);
  const r = await w.hunter().claim({ claimDir: dir });
  assert.deepEqual(r.sent.map((x) => x.action), ['drawJury']);
  const info = await w.aggregator.getRoundInfo(requestId);
  assert.equal(info.phase, 3n);
  const { evalWallet } = await w.sa.getClaim(claimId);
  assert.ok(await w.aggregator.ethOwed(evalWallet) > 0n, 'the draw reward is the wallet\'s');
  assert.equal(r.state, 'Revealed');
  assert.equal(r.round.phase, 3n);
  assert.equal(r.round.deadline, info.deadline);
  assert.match(r.next, /drawn and open/);
  assert.match(r.next, new RegExp(`deadline is ${info.deadline}`));
});
