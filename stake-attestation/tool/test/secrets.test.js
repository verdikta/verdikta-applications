// Review focus: keys are never logged. No key, disclosure secret, plaintext archive or credential reaches
// stdout, stderr, an error or a callback, on any path, including from an RPC, a pin target and a runner that
// echo whatever they are sent. And the wallet key comes from the environment or a private file, never argv.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import { closeRpc, envFor, readJson, rpcOf, runCli, spawnCli, statePath } from './helpers/cli.js';
import { TOKEN, startRunner } from './helpers/runner.js';
import { POC_MARKER, REPORT_MARKER, allForms, assertNoForms, formsOf, makeClaimDir, makeWorld, tmpDir, vectorOf, JUSTIFICATION_CID } from './helpers/world.js';

const PIN_TOKEN = 'a-pin-service-token-for-tests-77aa';
let w;
let rpc;
before(async () => {
  w = await makeWorld();
  rpc = await rpcOf(w);
});
after(async () => {
  await closeRpc(w);
  await w.close();
});

const secretsOf = (dir, keysFile = statePath(dir, 'keys.json')) => {
  const keys = fs.existsSync(keysFile) ? readJson(keysFile) : { contentKey: '', ephemeralKey: '' };
  return {
    wallet: keys.contentKey === undefined ? [] : formsOf(w.hunterKey),
    contentKey: keys.contentKey ? formsOf(keys.contentKey) : [],
    ephemeralKey: keys.ephemeralKey ? formsOf(keys.ephemeralKey) : [],
    report: [REPORT_MARKER],
    poc: [POC_MARKER],
    token: [TOKEN, PIN_TOKEN],
  };
};
const extra = { VERDIKTA_PIN_TOKEN: PIN_TOKEN };

test('the whole life of a claim through the CLI: no output carries a key, a credential or the plaintext', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const outs = [];
  const run = async (args, opt = {}) => {
    const r = await runCli(w, args, { extra, ...opt });
    outs.push(r);
    return r;
  };
  const c = await run(['commit', dir, '--listing', String(l.listingId), '--yes']);
  assert.equal(c.code, 0, c.stderr);
  const s = await run(['status', dir]);
  assert.equal(s.code, 0, s.stderr);
  const v = await run(['reveal', dir]);
  assert.equal(v.code, 0, v.stderr);
  const { claimId } = readJson(statePath(dir));
  await (await w.aggregator.scriptResult((await w.sa.getClaim(claimId)).requestId, vectorOf('INVALID'), JUSTIFICATION_CID)).wait();
  const k = await run(['claim', dir]);
  assert.equal(k.code, 0, k.stderr);
  const j = await run(['status', dir, '--json']);
  assert.equal(j.code, 0, j.stderr);
  // After the reveal the keys are public on-chain, but the tool still has no reason to print them.
  for (const r of outs) assertNoForms(`${r.stdout}\n${r.stderr}`, secretsOf(dir), 'CLI output');
});

test('an RPC that quotes every request back in its errors, at each verb: nothing of it reaches the hunter', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const ok = await runCli(w, ['commit', dir, '--listing', String(l.listingId), '--yes'], { extra });
  assert.equal(ok.code, 0, ok.stderr);
  const secrets = secretsOf(dir);
  for (const args of [['reveal', dir], ['status', dir], ['claim', dir], ['commit', dir, '--listing', String(l.listingId), '--yes']]) {
    rpc.options.echoErrors = true;
    const r = await runCli(w, args, { extra });
    rpc.options.echoErrors = false;
    assert.notEqual(r.code, 0, args[0]);
    assertNoForms(`${r.stdout}\n${r.stderr}`, secrets, `${args[0]} under an echoing RPC`);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /rejected:|"method"|eth_/, `${args[0]} relays the RPC's text`);
  }
});

test('the signed reveal bounced by an RPC that quotes it: the error is ours, without the calldata', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const { ethers } = await import('ethers');
  await w.hunter().commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const keys = readJson(statePath(dir, 'keys.json'));
  const quoting = new Proxy(w.provider, {
    get(target, prop) {
      if (prop === 'broadcastTransaction') {
        return async (raw) => {
          const e = new Error(`could not send ${raw}`);
          Object.assign(e, { code: 'SERVER_ERROR', transaction: raw, info: { raw }, shortMessage: raw });
          throw e;
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const err = await w.hunter({ provider: quoting, signer: new ethers.Wallet(w.hunterKey, w.provider) }).reveal({ claimDir: dir }).catch((e) => e);
  assert.equal(err.code, 'RPC_UNAVAILABLE');
  assertNoForms(allForms(err), { contentKey: formsOf(keys.contentKey), ephemeralKey: formsOf(keys.ephemeralKey), wallet: formsOf(w.hunterKey) }, 'error');
  assertNoForms(util.inspect(err, { depth: 10, showHidden: true }), { contentKey: formsOf(keys.contentKey), ephemeralKey: formsOf(keys.ephemeralKey), wallet: formsOf(w.hunterKey) }, 'inspected error');
  assert.equal(err.cause, undefined, 'no cause to dump');
});

test('a pin target that quotes the credential back in its error: not shown', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  await w.hunter({ onStep: (s) => { if (s === 'commit:saved') throw new Error('crash'); } }).commit({ claimDir: dir, listingId: l.listingId, acknowledge: true }).catch(() => {});
  w.ipfs.faults.pinDown = true;
  w.ipfs.faults.echo = true;
  const r = await runCli(w, ['commit', dir, '--listing', String(l.listingId)], { extra: { ...extra, VERDIKTA_PIN_BACKEND: 'filebase', VERDIKTA_PIN_TOKEN: PIN_TOKEN } });
  w.ipfs.faults.pinDown = false;
  w.ipfs.faults.echo = false;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PIN_FAILED/);
  assert.equal(r.stderr.includes(PIN_TOKEN), false);
  assert.equal(r.stdout.includes(PIN_TOKEN), false);
  const asked = w.ipfs.headers.at(-1).authorization;
  assert.equal(asked, `Bearer ${PIN_TOKEN}`, 'it was sent to the service, and only there');
});

test('a runner that quotes the token back: not shown', async () => {
  const runner = await startRunner();
  runner.state.echoToken = true;
  const l = await w.listing();
  const r = await runCli(w, ['check', makeClaimDir(), '--listing', String(l.listingId)], { extra: { CODE_RUNNER_URL: runner.url, CODE_RUNNER_TOKEN: 'a-wrong-token-for-this-runner-000000' } });
  await runner.close();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /RUNNER_UNAUTHORIZED/);
  assert.equal(`${r.stdout}${r.stderr}`.includes('a-wrong-token-for-this-runner-000000'), false);
});

test('callbacks and results of the library carry no secret', async () => {
  const l = await w.listing();
  const dir = makeClaimDir();
  const seen = [];
  const hunter = w.hunter({ onStep: (...a) => seen.push(a), onNotice: (...a) => seen.push(a) });
  const c = await hunter.commit({ claimDir: dir, listingId: l.listingId, acknowledge: true });
  const v = await hunter.reveal({ claimDir: dir });
  const secrets = secretsOf(dir);
  delete secrets.wallet;
  const dump = (x) => util.inspect(x, { depth: 10, showHidden: true });
  for (const x of [c, v, ...seen]) assertNoForms(dump(x), secrets, 'library value');
  assertNoForms(dump(hunter), { wallet: formsOf(w.hunterKey), ...secrets }, 'the hunter object');
});

test('the wallet key: refused on the command line, from a file with wider modes, or malformed, with the value never echoed', async () => {
  const l = await w.listing();
  const flag = await runCli(w, ['commit', makeClaimDir(), '--listing', String(l.listingId), '--key', w.hunterKey, '--yes'], { keyVia: 'none' });
  assert.equal(flag.code, 2);
  assert.equal(`${flag.stdout}${flag.stderr}`.includes(w.hunterKey.slice(2)), false);
  const keyDir = tmpDir();
  const file = path.join(keyDir, 'key');
  fs.writeFileSync(file, `${w.hunterKey}\n`, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const wide = await runCli(w, ['commit', makeClaimDir(), '--listing', String(l.listingId), '--key-file', file, '--yes'], { keyVia: 'none' });
  assert.equal(wide.code, 1);
  assert.match(wide.stderr, /WALLET_KEY_FILE/);
  fs.chmodSync(file, 0o600);
  const good = await runCli(w, ['commit', makeClaimDir(), '--listing', String(l.listingId), '--key-file', file, '--yes'], { keyVia: 'none' });
  assert.equal(good.code, 0, good.stderr);
  const bad = await runCli(w, ['commit', makeClaimDir(), '--listing', String(l.listingId), '--yes'], { keyVia: 'none', extra: { VERDIKTA_WALLET_KEY: 'not-a-key-but-still-a-secret-value' } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /WALLET_KEY_INVALID/);
  assert.equal(bad.stderr.includes('not-a-key-but-still-a-secret-value'), false);
  const none = await runCli(w, ['commit', makeClaimDir(), '--listing', String(l.listingId), '--yes'], { keyVia: 'none' });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /WALLET_KEY_MISSING/);
});

test('an unexpected exception in a process prints its kind only: the text of an unknown error could quote anything', async () => {
  const rpcUrl = rpc.url;
  const env = envFor(w, rpcUrl, { extra: { VERDIKTA_TEST_ONLY_NOTHING: '1' } });
  const r = await spawnCli(['status', '1'], { ...env, VERDIKTA_CONTRACT: 'not-an-address' });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/, 'no stack');
});

test('check prints the pack (the acceptance) and nothing else plain: no key exists yet, and --no-pack leaves out the proof', async () => {
  const runner = await startRunner();
  const l = await w.listing();
  const dir = makeClaimDir();
  const quiet = await runCli(w, ['check', dir, '--listing', String(l.listingId), '--no-pack'], { runner });
  await runner.close();
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(`${quiet.stdout}${quiet.stderr}`.includes(REPORT_MARKER), false);
  assert.equal(`${quiet.stdout}${quiet.stderr}`.includes(POC_MARKER), false);
  assert.equal(`${quiet.stdout}${quiet.stderr}`.includes(TOKEN), false);
});

test('the scrubber catches a secret that gets as far as the writer, whatever the path', async () => {
  const { scrubber } = await import('../src/index.js');
  const scrub = scrubber();
  const key = `0x${'ab'.repeat(32)}`;
  scrub.add(key);
  for (const form of formsOf(key)) assert.equal(scrub(`x ${form} y`).includes(form), false, form);
  assert.equal(scrub(`x ${key} y`).includes('ab'.repeat(32)), false);
  assert.equal(scrub('no secret here'), 'no secret here');
});
