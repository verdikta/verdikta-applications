// Node P9 (owner decision Q34, "the project decides"): the builder refuses a listing without the
// project's proof, before it fetches or builds anything, with a named code; nothing is signed. The
// repository half runs real git against local bare repositories (no network): a local bare
// repository serves any object it holds by id, exactly as GitHub serves a fork's commit through the
// parent's URL, so the fork-only commit here is the real attack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Wallet, getAddress } from 'ethers';

import { main } from '../../src/cli.js';
import { parseConfig } from '../../src/config.js';
import { explorerChain, createExplorer } from '../../src/explorer.js';
import { deploymentMessage, recheckForSigning } from '../../src/listingProof.js';
import { REPO, MAKER, attempt, config, deployment, stake } from '../helpers/proof.js';
import { makeRepo, proofFile } from '../helpers/proofRepo.js';
import { contractDraft, draftSpec, runnerWithGrammar } from '../helpers/specs.js';

const STRANGER = getAddress('0xab8483f64d9c6d1ecf9b849ae677dd3315835cb2');
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// a temporary folder of this file's: another test file counts what the real check leaves in the shared one
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-proof-tests-'));

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-proof-'));
  return { ...makeRepo(dir), dir };
}

function nothingBuilt(r, code, step = 'control') {
  assert.equal(r.status, 'refused', JSON.stringify(r.report.error));
  assert.equal(r.report.refusals[0].code, code);
  assert.equal(r.report.refusals[0].step, step);
  assert.equal(typeof r.report.refusals[0].detail, 'string');
  assert.equal(r.files.size, 0);
  assert.deepEqual(r.report.steps.map((s) => s.name), step === 'control' ? ['spec', 'control'] : r.report.steps.map((s) => s.name));
  assert.equal(r.calls.fetch.length, 0, 'nothing of the repository was fetched for a build');
  assert.equal(r.calls.docker, 0, 'docker never ran');
}

test('the project\'s own listing passes: the file at a commit on a branch names the maker', async () => {
  const h = repo();
  const commit = h.commit({ file: proofFile(MAKER) });
  const r = await attempt({ h, commit });
  assert.equal(r.status, 'accepted', JSON.stringify(r.report.refusals));
  assert.equal(r.report.steps[1].name, 'control');
  assert.equal(r.report.steps[1].status, 'ok');
  assert.equal(r.report.control.maker, MAKER);
  assert.equal(r.report.control.path, '.verdikta/stake-control.json');
  assert.equal(r.report.control.ref, 'refs/heads/main');
  assert.equal(r.report.control.deployment, null);
  assert.match(r.report.control.blob, /^[0-9a-f]{40}$/);
});

test('a commit on a tag only passes: a tag is one of the repository\'s own refs', async () => {
  const h = repo();
  const commit = h.commit({ file: proofFile(MAKER), branch: null, tag: 'v1.0.0' });
  const r = await attempt({ h, commit });
  assert.equal(r.status, 'accepted', JSON.stringify(r.report.refusals));
  assert.equal(r.report.control.ref, 'refs/tags/v1.0.0');
});

test('a sponsor can stake only if the project names it, and a request from anyone else with that file is refused', async () => {
  const h = repo();
  const sponsor = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  const commit = h.commit({ file: proofFile(sponsor) });
  assert.equal((await attempt({ h, commit, maker: sponsor })).status, 'accepted');
  nothingBuilt(await attempt({ h, commit, maker: MAKER }), 'PROOF_NAMES_ANOTHER_ADDRESS');
});

test('the file\'s address may be lowercase; the comparison is in checksummed form', async () => {
  const h = repo();
  const commit = h.commit({ file: proofFile(MAKER.toLowerCase()) });
  assert.equal((await attempt({ h, commit })).status, 'accepted');
  // and the maker's own spelling does not matter either
  assert.equal((await attempt({ h, commit, maker: MAKER.toLowerCase() })).status, 'accepted');
});

test('no maker, or something that is not an address: refused, nothing fetched', async () => {
  const h = repo();
  const commit = h.commit({ file: proofFile(MAKER) });
  nothingBuilt(await attempt({ h, commit, maker: null }), 'MAKER_REQUIRED');
  nothingBuilt(await attempt({ h, commit, maker: 'not-an-address' }), 'MAKER_INVALID');
  nothingBuilt(await attempt({ h, commit, maker: `0x${'0'.repeat(40)}` }), 'MAKER_INVALID');
});

test('no proof file at the commit: refused', async () => {
  const h = repo();
  nothingBuilt(await attempt({ h, commit: h.commit() }), 'NO_PROOF_FILE');
});

test('a file naming another address: refused, whoever else it names', async () => {
  const h = repo();
  nothingBuilt(await attempt({ h, commit: h.commit({ file: proofFile(STRANGER) }) }), 'PROOF_NAMES_ANOTHER_ADDRESS');
});

test('one address only: a list, other keys, another version, a failed checksum or a symlink name nobody', async () => {
  const h = repo();
  const bad = [
    JSON.stringify({ version: 1, maker: [MAKER, STRANGER] }),
    JSON.stringify({ version: 1, makers: [MAKER] }),
    JSON.stringify({ version: 1, maker: MAKER, sponsor: STRANGER }),
    JSON.stringify({ version: 2, maker: MAKER }),
    JSON.stringify({ version: 1, maker: MAKER.replace('B', 'b') }),
    JSON.stringify({ version: 1, maker: MAKER.toUpperCase().replace('0X', '0x') }),
    'not json',
  ];
  for (const file of bad) nothingBuilt(await attempt({ h, commit: h.commit({ file }) }), 'PROOF_FILE_INVALID');
  nothingBuilt(await attempt({ h, commit: h.commit({ symlinkTo: '../src/Vault.sol' }) }), 'PROOF_FILE_INVALID');
});

test('a fork-only commit is refused, though the host serves it by id and its file names the maker', async () => {
  const h = repo();
  const forked = h.commit({ file: proofFile(MAKER), branch: null });
  nothingBuilt(await attempt({ h, commit: forked }), 'COMMIT_NOT_ON_OWN_REFS');
});

test('a commit under refs/pull/<n>/head only is refused', async () => {
  const h = repo();
  const forked = h.commit({ file: proofFile(MAKER), branch: null });
  h.pullRef(forked, 42);
  nothingBuilt(await attempt({ h, commit: forked }), 'COMMIT_NOT_ON_OWN_REFS');
});

test('a repository the site could not read is refused before anything else', async () => {
  const h = repo();
  const commit = h.commit({ file: proofFile(MAKER) });
  nothingBuilt(await attempt({ h, commit, repoUrl: 'https://github.com/acme/vault/../other' }), 'REPO_URL_FORM');
  nothingBuilt(await attempt({ h, commit, repoUrl: 'https://github.com.evil.example/acme/vault' }), 'REPO_HOST_NOT_CHECKED');
});

test('no exception by name: a Verdikta repository and maker get the same refusal', async () => {
  const h = repo();
  const commit = h.commit();
  const r = await attempt({ h, commit, repoUrl: 'https://github.com/verdikta/verdikta-applications' });
  nothingBuilt(r, 'NO_PROOF_FILE');
});

test('a contract listing needs both: the repository file and the deployer\'s or owner\'s signature', async () => {
  const h = repo();
  const owner = Wallet.createRandom();
  const draft = contractDraft({ repo: REPO, baseCommit: h.commit({ file: proofFile(MAKER) }) });
  const chain = deployment({ owner: owner.address });
  const message = deploymentMessage({ spec: draft, maker: MAKER, stake });

  nothingBuilt(await attempt({ h, draft, chain }), 'NO_SIGNATURE');

  const signed = { signer: owner.address, signature: await owner.signMessage(message), stakeChainId: stake.chainId, stakeContract: stake.address };
  const ok = await attempt({ h, draft, chain, deploymentProof: signed });
  assert.equal(ok.status, 'accepted', JSON.stringify(ok.report.refusals ?? ok.report.error));
  assert.equal(ok.report.control.deployment.signer, owner.address);
  assert.equal(ok.report.control.deployment.role, 'owner');

  // the file alone is not enough, and neither is the signature alone
  const noFile = contractDraft({ repo: REPO, baseCommit: h.commit() });
  const noFileMessage = deploymentMessage({ spec: noFile, maker: MAKER, stake });
  const signedNoFile = { ...signed, signature: await owner.signMessage(noFileMessage) };
  nothingBuilt(await attempt({ h, draft: noFile, chain, deploymentProof: signedNoFile }), 'NO_PROOF_FILE');
});

test('a contract\'s deployer signs with its creation transaction', async () => {
  const h = repo();
  const deployer = Wallet.createRandom();
  const creationTx = `0x${'ab'.repeat(32)}`;
  const draft = contractDraft({ repo: REPO, baseCommit: h.commit({ file: proofFile(MAKER) }) });
  const chain = deployment({ owner: null, deployer: deployer.address, creationTx, address: getAddress(draft.artifact.address.toLowerCase()) });
  const signature = await deployer.signMessage(deploymentMessage({ spec: draft, maker: MAKER, stake }));
  const r = await attempt({ h, draft, chain, deploymentProof: { signer: deployer.address, signature, creationTx, stakeChainId: stake.chainId, stakeContract: stake.address } });
  assert.equal(r.status, 'accepted', JSON.stringify(r.report.refusals ?? r.report.error));
  assert.equal(r.report.control.deployment.role, 'deployer');
});

test('a contract\'s signature that does not count is refused with its code', async () => {
  const h = repo();
  const owner = Wallet.createRandom();
  const stranger = Wallet.createRandom();
  const draft = contractDraft({ repo: REPO, baseCommit: h.commit({ file: proofFile(MAKER) }) });
  const chain = deployment({ owner: owner.address });
  const message = deploymentMessage({ spec: draft, maker: MAKER, stake });
  const proof = (o) => ({ stakeChainId: stake.chainId, stakeContract: stake.address, ...o });

  // the wrong person signs the right message
  nothingBuilt(await attempt({ h, draft, chain, deploymentProof: proof({ signer: stranger.address, signature: await stranger.signMessage(message) }) }), 'SIGNER_NOT_CONTROLLER');
  // the owner signed for another maker: another message
  const forOther = await owner.signMessage(deploymentMessage({ spec: draft, maker: STRANGER, stake }));
  nothingBuilt(await attempt({ h, draft, chain, deploymentProof: proof({ signer: owner.address, signature: forOther }) }), 'SIGNATURE_INVALID');
  // no code at the address
  nothingBuilt(await attempt({ h, draft, chain: deployment({ owner: owner.address, code: '0x' }), deploymentProof: proof({ signer: owner.address, signature: await owner.signMessage(message) }) }), 'NO_CONTRACT_AT_ADDRESS');
  // not a proof at all
  nothingBuilt(await attempt({ h, draft, chain, deploymentProof: proof({ signer: 'nobody', signature: 'x' }) }), 'SIGNATURE_INVALID');
});

// Node P25: the testnet maker's wallet has code, an EIP-7702 delegation designator (0xef0100 and a delegate's
// address), and its owner signs with the account's own key. Its signature is ordinary ECDSA wherever the builder
// checks it: the proof check recovers it before it reads any code, and sign repeats that recovery.
test('a maker whose wallet holds a 7702 designator owns the deployment and signs with its own key: ECDSA, no isValidSignature, and sign takes it too', async () => {
  const h = repo();
  const wallet = Wallet.createRandom();
  const designator = `0xef0100${Wallet.createRandom().address.slice(2).toLowerCase()}`;
  const draft = contractDraft({ repo: REPO, baseCommit: h.commit({ file: proofFile(wallet.address) }) });
  const base = deployment({ owner: wallet.address });
  const reads = [];
  const chain = {
    ...base,
    getCode: async (address, tag) => { reads.push({ getCode: address }); return address === wallet.address ? designator : base.getCode(address, tag); },
    call: async (tx) => { reads.push({ call: tx.to, selector: tx.data.slice(0, 10) }); return base.call(tx); },
  };
  const signature = await wallet.signMessage(deploymentMessage({ spec: draft, maker: wallet.address, stake }));
  const r = await attempt({ h, draft, chain, maker: wallet.address, deploymentProof: { signer: wallet.address, signature, stakeChainId: stake.chainId, stakeContract: stake.address } });
  assert.equal(r.status, 'accepted', JSON.stringify(r.report.refusals ?? r.report.error));
  assert.equal(r.report.control.maker, wallet.address);
  assert.equal(r.report.control.deployment.signer, wallet.address);
  assert.equal(r.report.control.deployment.role, 'owner');
  assert.equal(r.report.control.deployment.contractSigner, false);
  assert.equal(reads.some((x) => x.selector === '0x1626ba7e'), false, 'no EIP-1271 call');
  assert.equal(reads.some((x) => x.getCode === wallet.address), false, 'ECDSA first: the wallet\'s code is never read');
  assert.ok(reads.some((x) => x.getCode === getAddress(draft.artifact.address.toLowerCase())), 'the deployment\'s code is read, as for any listing');

  const cfg = parseConfig(config({ repoMirrors: { [draft.repo]: h.mirror } }), { baseDir: '/tmp', env: { CODE_RUNNER_TOKEN: 'runner-token-0123456789abcdef0123456789' } });
  await recheckForSigning({ spec: draft, report: r.report, maker: wallet.address, config: cfg });
});

// Node P25: the testnet launch's seeded listings are of this repository, and the builder reads its proof file as it
// reads any listing's. shared/test/repo/controlFile.test.js holds the file to its format and its maker.
test('this repository\'s own proof file, as the builder reads it: a listing of it passes for the maker it names, and no one else', async () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, '.verdikta', 'stake-control.json'), 'utf8');
  const named = JSON.parse(text).maker;
  const checkRepositoryControl = async () => ({ reachable: true, ref: 'refs/heads/main', file: { path: '.verdikta/stake-control.json', mode: '100644', blob: 'b'.repeat(40), size: Buffer.byteLength(text), text, problem: null } });
  // the URL read is the stand-in's: what decides is the file's text, which is this repository's
  const h = repo();
  const commit = h.commit();
  const ok = await attempt({ h, commit, maker: named, checkRepositoryControl });
  assert.equal(ok.status, 'accepted', JSON.stringify(ok.report.refusals ?? ok.report.error));
  assert.equal(ok.report.control.maker, named, 'the file writes the maker in the form the builder compares');
  nothingBuilt(await attempt({ h, commit, maker: STRANGER, checkRepositoryControl }), 'PROOF_NAMES_ANOTHER_ADDRESS');
});

test('a chain that cannot be read is an error to retry, never an acceptance', async () => {
  const h = repo();
  const owner = Wallet.createRandom();
  const draft = contractDraft({ repo: REPO, baseCommit: h.commit({ file: proofFile(MAKER) }) });
  const signature = await owner.signMessage(deploymentMessage({ spec: draft, maker: MAKER, stake }));
  const down = deployment({ owner: owner.address, down: true });
  const r = await attempt({ h, draft, chain: down, deploymentProof: { signer: owner.address, signature, stakeChainId: stake.chainId, stakeContract: stake.address } });
  assert.equal(r.status, 'error');
  assert.equal(r.report.error.code, 'EXPLORER_UNAVAILABLE');
  assert.equal(r.files.size, 0);
});

test('a repository that cannot be read is an error to retry; one over the cap is refused', async () => {
  const h = repo();
  const commit = h.commit({ file: proofFile(MAKER) });
  const failed = await attempt({ h, commit, checkRepositoryControl: async () => { const { BuilderError } = await import('../../src/errors.js'); throw new BuilderError('REPO_FETCH_FAILED', 'the host answered 503'); } });
  assert.equal(failed.status, 'error');
  assert.equal(failed.report.error.code, 'REPO_FETCH_FAILED');
  const large = await attempt({ h, commit, checkRepositoryControl: async () => { const { BuilderError } = await import('../../src/errors.js'); throw new BuilderError('REPO_TOO_LARGE', 'over'); } });
  nothingBuilt(large, 'REPO_TOO_LARGE');
});

test('the explorer stands in for the chain\'s RPC: its answers, in the form the proof check reads', async () => {
  const seen = [];
  const results = {
    eth_chainId: '0x2105',
    eth_blockNumber: '0x10',
    eth_getCode: '0x6001',
    eth_call: `0x${'0'.repeat(24)}${'ab'.repeat(20)}`,
    eth_getTransactionByHash: { from: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' },
    eth_getTransactionReceipt: { status: '0x1', blockNumber: '0xf', contractAddress: '0x5f2a00000000000000000000000000000000c0de' },
  };
  const explorer = createExplorer({
    apiUrl: 'https://explorer.test/api',
    chainId: 8453,
    fetch: async (url) => {
      const u = new URL(String(url));
      seen.push(u);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: results[u.searchParams.get('action')] }));
    },
  });
  const chain = explorerChain(explorer);
  assert.equal(await chain.send('eth_chainId', []), '0x2105');
  assert.equal(await chain.getBlockNumber(), 16);
  assert.equal(await chain.getCode('0x5f2A00000000000000000000000000000000C0dE', 16), '0x6001');
  assert.equal(await chain.call({ to: '0x5f2A00000000000000000000000000000000C0dE', data: '0x8da5cb5b', blockTag: 16 }), results.eth_call);
  assert.equal(seen.at(-1).searchParams.get('tag'), 'latest', 'the proxy module takes no block number');
  assert.equal((await chain.getTransaction('0xab')).from, getAddress(results.eth_getTransactionByHash.from));
  const rc = await chain.getTransactionReceipt('0xab');
  assert.deepEqual([rc.status, rc.blockNumber, rc.contractAddress], [1, 15, getAddress(results.eth_getTransactionReceipt.contractAddress)]);
});

test('an explorer\'s revert is a revert to the proof check; anything else is the explorer being unavailable', async () => {
  const answers = [{ error: { code: 3, message: 'execution reverted' } }, { status: '0', message: 'NOTOK', result: 'Max rate limit reached' }];
  const explorer = createExplorer({ apiUrl: 'https://explorer.test/api', chainId: 8453, fetch: async () => new Response(JSON.stringify(answers.shift())) });
  const chain = explorerChain(explorer);
  await assert.rejects(chain.call({ to: MAKER, data: '0x', blockTag: 1 }), (err) => err.code === 'CALL_EXCEPTION');
  await assert.rejects(chain.call({ to: MAKER, data: '0x', blockTag: 1 }), (err) => err.code === 'EXPLORER_UNAVAILABLE');
});

// the command line: what the server runs

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vab-proof-cli-'));
}
function io() {
  let out = '';
  let err = '';
  return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, get out() { return out; }, get err() { return err; } };
}

test('verdikta-build-env build without --maker: refused with its code and a report, exit 2', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(draftSpec()));
  fs.writeFileSync(path.join(dir, 'builder.json'), JSON.stringify(config()));
  const o = io();
  const code = await main(['build', '--config', path.join(dir, 'builder.json'), '--spec', path.join(dir, 'draft.json'), '--out', path.join(dir, 'out')], { env: { CODE_RUNNER_TOKEN: 'x' }, stdout: o.stdout, stderr: o.stderr, deps: { runner: runnerWithGrammar() } });
  assert.equal(code, 2, o.err);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'validation-report.json'), 'utf8'));
  assert.equal(report.status, 'refused');
  assert.equal(report.refusals[0].code, 'MAKER_REQUIRED');
  assert.equal(fs.existsSync(path.join(dir, 'out', 'code_review.json')), false);
});
