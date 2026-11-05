// The site's build through Verdikta's caller (node P15): a stranger's request runs in Verdikta's repository, so
// what these files allow is the whole of what a stranger gets. They read the YAML and run the scripts it calls,
// with real wallets. Nothing here reaches GitHub or a cloud.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Wallet } from 'ethers';
import { parse } from 'yaml';
import { LIST_ACTION, authMessageText } from '@verdikta/stake-attestation-shared/auth-message';
import { encodeSiteAuth, encodeSiteRequest, serializeKnownIssues } from '@verdikta/stake-attestation-shared/site-request';

import { checkSignedFiles, unpackSiteRequest } from '../../action/site-request.js';
import { main } from '../../src/cli.js';
import { neutralize } from '../../src/logSafe.js';
import { contractDraft, draftSpec } from '../helpers/specs.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const APP = path.join(REPO_ROOT, 'stake-attestation');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const CALLER_FILE = path.join(APP, 'builder', 'caller', 'stake-attestation-site-build.yml');
const callerText = fs.readFileSync(CALLER_FILE, 'utf8');
const caller = parse(callerText);
const mainText = fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation-builder.yml'), 'utf8');
const builder = parse(mainText);
const signText = fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation-builder-sign.yml'), 'utf8');
const signer = parse(signText);
const DOC = fs.readFileSync(path.join(APP, 'docs', 'builder-kms-signing.md'), 'utf8');
const README = fs.readFileSync(path.join(APP, 'README.md'), 'utf8');
const IMAGE_REPOSITORY = 'ghcr.io/verdikta/stake-env';
const SCRIPT = fileURLToPath(new URL('../../action/site-request.js', import.meta.url));

const steps = (j) => builder.jobs[j].steps;
const runsOf = (j) => steps(j).filter((s) => s.run).map((s) => s.run).join('\n');

describe('the caller, which the owner copies', () => {
  test('it starts only by workflow_dispatch, and asks for nothing at the top', () => {
    assert.deepEqual(Object.keys(caller.on), ['workflow_dispatch']);
    assert.deepEqual(caller.permissions, {});
    assert.deepEqual(Object.keys(caller.on.workflow_dispatch.inputs).sort(), ['auth', 'correlation-id', 'maker', 'request']);
    assert.equal(caller['run-name'], '${{ inputs.correlation-id }}', 'how a server finds its run, also after a restart');
  });

  test('what runs is fixed in the file: no input can name a workflow, a commit, an environment or where the image goes', () => {
    assert.deepEqual(Object.keys(caller.jobs), ['listing', 'sign']);
    const { listing, sign } = caller.jobs;
    assert.equal(listing.uses, 'verdikta/verdikta-applications/.github/workflows/stake-attestation-builder.yml@BUILDER_COMMIT');
    assert.equal(sign.uses, 'verdikta/verdikta-applications/.github/workflows/stake-attestation-builder-sign.yml@BUILDER_COMMIT');
    for (const j of [listing, sign]) {
      assert.equal(j.with['builder-ref'], 'BUILDER_COMMIT');
      assert.equal(j.with['publish-repository'], IMAGE_REPOSITORY);
      assert.equal(j.environment, undefined);
      assert.equal(j.steps, undefined, 'the caller runs no script of its own');
    }
    assert.equal(listing.with.signing, 'production');
    assert.equal(listing.with['artifact-name'], 'site', 'the server looks for site-listing-signed');
    assert.equal(listing.with.spec, undefined);
    assert.equal(sign.needs, 'listing');
    assert.doesNotMatch(callerText, /secrets: inherit/);
    assert.doesNotMatch(callerText, /\bref:\s*\$\{\{/);
  });

  test('only the sign job can mint a cloud identity; the listing job holds what publish needs and hands none of it to build', () => {
    assert.deepEqual(caller.jobs.listing.permissions, { contents: 'read', packages: 'write' });
    assert.deepEqual(caller.jobs.sign.permissions, { contents: 'read', 'id-token': 'write' });
    assert.equal(caller.jobs.listing.secrets, undefined, 'the build side gets no secret');
    assert.deepEqual(Object.keys(caller.jobs.sign.secrets).sort(), ['VERDIKTA_KMS_KEY_ARN', 'VERDIKTA_KMS_ROLE_ARN']);
  });

  test('the request and its signature reach both sides, and the explorer comes from a variable the server\'s token cannot change', () => {
    const { listing, sign } = caller.jobs;
    for (const j of [listing, sign]) {
      assert.equal(j.with['site-request'], '${{ inputs.request }}');
      assert.equal(j.with['site-auth'], '${{ inputs.auth }}');
      assert.equal(j.with.maker, '${{ inputs.maker }}');
    }
    assert.equal(listing.with['site-explorers'], '${{ vars.STAKE_ATTESTATION_EXPLORERS }}');
    assert.equal(listing.with['explorer-api-url'], undefined);
    assert.equal(Object.keys(caller.on.workflow_dispatch.inputs).some((k) => /explorer|chain|url|ref|repo|file/i.test(k)), false);
    const start = steps('build').find((s) => /services\.js" start\b/.test(s.run ?? ''));
    assert.equal(start.env.EXPLORER_API_URL, '${{ needs.source.outputs.explorer-api-url }}');
  });

  test('its name is the one the trust policy compares', () => {
    assert.equal(caller.name, 'Stake attestation site build');
    assert.match(DOC, /"token\.actions\.githubusercontent\.com:workflow": "Stake attestation site build"/);
  });

  test('CI lints it with the workflows', () => {
    assert.match(fs.readFileSync(path.join(WORKFLOWS, 'stake-attestation.yml'), 'utf8'), /stake-attestation\/builder\/caller\/stake-attestation-site-build\.yml/);
  });
});

describe('the build job runs a stranger\'s setup', () => {
  test('it has no permission at all, no secret, no environment and no OIDC', () => {
    const b = builder.jobs.build;
    assert.deepEqual(b.permissions, {});
    assert.equal(b.environment, undefined);
    const text = JSON.stringify(b);
    assert.doesNotMatch(text, /secrets\./);
    assert.doesNotMatch(text, /github\.token/);
    assert.doesNotMatch(text, /id-token/);
    assert.doesNotMatch(text, /inputs\.(spec|known-issues|deployment-proof|site-request|site-auth)\b/, 'the request reached it through the source job, as files');
    for (const c of steps('build').filter((s) => String(s.uses ?? '').startsWith('actions/checkout@'))) {
      assert.equal(c.with.repository, 'verdikta/verdikta-applications', 'the builder only: the caller\'s repository is not checked out here');
      assert.equal(c.with['persist-credentials'], false);
    }
  });

  test('no job of the reusable workflow may ask for an identity, and only publish may write a package', () => {
    for (const [name, j] of Object.entries(builder.jobs)) {
      assert.equal(j.permissions?.['id-token'], undefined, name);
      if (name !== 'publish') assert.equal(j.permissions?.packages, undefined, name);
    }
    assert.deepEqual(builder.jobs.publish.permissions, { contents: 'read', packages: 'write' });
  });

  test('the maker\'s code runs in one job only: source, publish and sign run nothing it wrote, and hold no route from it but data', () => {
    assert.match(runsOf('build'), /verdikta-build-env\.js" build\b/);
    for (const j of ['source', 'publish', 'sign']) assert.doesNotMatch(runsOf(j), /verdikta-build-env\.js" (build|run)\b/, j);
    assert.doesNotMatch(runsOf('source'), /docker/);
    for (const c of [...steps('publish'), ...steps('sign'), ...signer.jobs.sign.steps].filter((s) => String(s.uses ?? '').startsWith('actions/checkout@'))) {
      assert.equal(c.with.repository, 'verdikta/verdikta-applications');
    }
    // A cache is the one thing a job on main can leave for a later one: nothing here restores one.
    for (const text of [mainText, signText]) assert.doesNotMatch(text, /actions\/cache|^\s+cache:/m);
    for (const job of [...Object.values(builder.jobs), ...Object.values(signer.jobs)]) {
      for (const s of job.steps) if (String(s.uses ?? '').startsWith('actions/setup-node@')) assert.equal(s.with.cache, undefined);
    }
  });

  test('nothing an input holds reaches a script but through its environment', () => {
    for (const [file, wf] of [['builder', builder], ['sign', signer]]) {
      for (const [name, j] of Object.entries(wf.jobs)) {
        for (const s of j.steps) if (s.run) assert.doesNotMatch(s.run, /\$\{\{/, `${file} ${name}: ${s.name}`);
      }
    }
    for (const { run } of steps('source')) if (run) assert.doesNotMatch(run, /\$\{\{/);
  });

  test('the request is opened on a machine that runs nothing of the maker\'s, and leaves as files', () => {
    const s = builder.jobs.source;
    assert.deepEqual(s.permissions, { contents: 'read' });
    const open = steps('source').find((x) => /site-request\.js unpack/.test(x.run ?? ''));
    assert.equal(open.if, "inputs.site-request != ''");
    assert.equal(open.env.SITE_REQUEST, '${{ inputs.site-request }}');
    assert.equal(open.env.SITE_AUTH, '${{ inputs.site-auth }}');
    assert.equal(open.env.MAKER, '${{ inputs.maker }}');
    const checkout = steps('source').find((x) => String(x.uses ?? '').startsWith('actions/checkout@') && x.with.repository === undefined);
    assert.equal(checkout.if, "inputs.site-request == ''", 'a site request never touches the caller\'s repository');
    assert.equal(builder.jobs.build.needs, 'source');
    const download = steps('build').find((x) => String(x.uses ?? '').startsWith('actions/download-artifact@'));
    assert.equal(download.with.name, '${{ needs.source.outputs.artifact-id }}-source');
    assert.equal(download.with.path, 'listing-source');
  });

  test('exactly one source of the draft: both or neither is refused before anything runs', () => {
    const guard = steps('source')[0];
    const run = (env) => spawnSync('bash', ['-c', guard.run], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    assert.equal(run({ SPEC: 'listing/code_review.json', SITE_REQUEST: '' }).status, 0);
    assert.equal(run({ SPEC: '', SITE_REQUEST: 'abc' }).status, 0);
    assert.equal(run({ SPEC: '', SITE_REQUEST: '' }).status, 1);
    assert.equal(run({ SPEC: 'x', SITE_REQUEST: 'abc' }).status, 1);
  });
});

describe('where a listing\'s image goes (Q42)', () => {
  test('the workflow header and the docs say ghcr.io/verdikta, pushed by the builder workflow, and no longer suggest a maker\'s namespace', () => {
    const header = mainText.slice(0, mainText.indexOf('\non:'));
    assert.match(header, /ghcr\.io\/verdikta/);
    assert.doesNotMatch(header, /ghcr\.io\/<owner>/);
    assert.doesNotMatch(mainText, /ghcr\.io\/<owner>/);
    assert.doesNotMatch(README, /ghcr\.io\/<owner>/);
    assert.match(README, /`ghcr\.io\/verdikta\/stake-env`/);
    assert.match(DOC, /publish-repository: ghcr\.io\/verdikta\/stake-env/);
  });

  test('a maker\'s own caller still names its own repository: dev signing is as it was', () => {
    const inputs = builder.on.workflow_call.inputs;
    assert.equal(inputs.signing.default, 'dev');
    assert.equal(inputs['publish-repository'].required, true);
    assert.equal(inputs['publish-repository'].default, undefined);
    assert.equal(builder.jobs.sign.if, "inputs.signing != 'production'");
  });
});

describe('the docs say what the owner accepted', () => {
  test('every point, plainly', () => {
    for (const needle of [
      /testnet-only/i, // the key
      /Actions: read and write/i,
      /start or cancel any workflow/i,
      /logs/,
      /with reviewers off/i,
      /several wallets/i,
      /git-host accounts/i,
      /before any review/i,
      /P15b/,
      /runc|container runtime/i,
      /STAKE_ATTESTATION_EXPLORERS/,
      /retiredAt/,
    ]) assert.match(DOC, needle);
    assert.doesNotMatch(DOC, /can only start/i);
  });

  test('no account detail', () => {
    for (const text of [DOC, callerText]) {
      assert.doesNotMatch(text, /\b[0-9]{12}\b/);
      assert.doesNotMatch(text, /arn:aws:(iam|kms):[a-z0-9-]*:[0-9]+/);
    }
  });
});

// A real wallet, the message the server's challenge makes, and what the jobs do with them.

const WALLET = Wallet.createRandom();
const THIEF = Wallet.createRandom();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ISSUES = [{ id: 'KI-1', title: 'A known issue', severity: 'LOW', description: 'text' }];

function requestOf({ spec = { ...draftSpec(), stake: { ...draftSpec().stake, knownIssues: 'known_issues.json' } }, knownIssues = ISSUES, maker = WALLET.address, deploymentProof, extra = {} } = {}) {
  return JSON.stringify({ spec, ...(knownIssues ? { knownIssues } : {}), allowlist: [], maker, ...(deploymentProof ? { deploymentProof } : {}), ...extra });
}

async function signedBy(wallet, signedJson, { address = wallet.address, stake = {} } = {}) {
  const fields = { nonce: 'c'.repeat(32), issuedAt: '2026-11-05T12:00:00Z', expiresAt: '2026-11-05T12:05:00Z' };
  const signature = await wallet.signMessage(authMessageText({ action: LIST_ACTION, resource: `list-request:${sha256(signedJson)}`, address, ...fields }));
  return { request: encodeSiteRequest(signedJson), auth: encodeSiteAuth({ ...fields, signature, ...stake }) };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vab-site-'));

function builtFolder(signedJson, edit = (x) => x) {
  const body = JSON.parse(signedJson);
  const dir = tmp();
  const built = edit({ ...body.spec, env: { ...body.spec.env, image: `${IMAGE_REPOSITORY}@sha256:${'a'.repeat(64)}`, platform: 'linux/amd64', unpackedBytes: 1 }, limits: { cpus: 2 }, attestation: 'attestation.json', baseline: 'baseline.json' });
  fs.writeFileSync(path.join(dir, 'code_review.json'), JSON.stringify(built));
  if (body.knownIssues) fs.writeFileSync(path.join(dir, built.stake.knownIssues), serializeKnownIssues(body.knownIssues));
  return dir;
}

describe('the source job opens the request', () => {
  test('a wallet-signed request becomes the files the build reads, at fixed names', async () => {
    const signedJson = requestOf();
    const { request, auth } = await signedBy(WALLET, signedJson);
    const out = tmp();
    const r = unpackSiteRequest({ request, auth, maker: WALLET.address, out });
    assert.deepEqual(r, { spec: 'draft.json', knownIssues: 'known_issues.json', deploymentProof: '', explorerApiUrl: '' });
    const body = JSON.parse(signedJson);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'draft.json'), 'utf8')), body.spec);
    assert.deepEqual(fs.readFileSync(path.join(out, 'known_issues.json')), serializeKnownIssues(ISSUES));
    assert.deepEqual(fs.readdirSync(out).sort(), ['draft.json', 'known_issues.json']);
  });

  test('a contract listing\'s proof carries the stake deployment the signature binds', async () => {
    const proof = { signer: WALLET.address, signature: `0x${'1'.repeat(130)}` };
    const signedJson = requestOf({ spec: contractDraft(), knownIssues: null, deploymentProof: proof });
    const { request, auth } = await signedBy(WALLET, signedJson, { stake: { stakeChainId: 84532, stakeContract: WALLET.address } });
    const out = tmp();
    const r = unpackSiteRequest({ request, auth, maker: WALLET.address, out });
    assert.equal(r.deploymentProof, 'control-proof.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'control-proof.json'), 'utf8')), { signer: WALLET.address, signature: proof.signature, creationTx: null, stakeChainId: 84532, stakeContract: WALLET.address });
  });

  test('a contract listing\'s explorer is the one for the chain the wallet signed: nothing sent can read one chain and attest another', async () => {
    const spec = contractDraft();
    const proof = { signer: WALLET.address, signature: `0x${'1'.repeat(130)}` };
    const signedJson = requestOf({ spec, knownIssues: null, deploymentProof: proof });
    const { request, auth } = await signedBy(WALLET, signedJson, { stake: { stakeChainId: 84532, stakeContract: WALLET.address } });
    const chain = String(spec.artifact.chainId);
    const go = (explorers) => unpackSiteRequest({ request, auth, maker: WALLET.address, out: tmp(), explorers });
    assert.equal(go(JSON.stringify({ [chain]: 'https://right.example/api', 999999: 'https://wrong.example/api' })).explorerApiUrl, 'https://right.example/api');
    assert.equal(go(JSON.stringify({ 999999: 'https://wrong.example/api' })).explorerApiUrl, '', 'none for its chain: the build refuses by its own code');
    assert.equal(go('').explorerApiUrl, '');
    for (const bad of ['{', JSON.stringify({ [chain]: 'http://plain.example' }), JSON.stringify({ [chain]: 'https://x.example/a\nspec=evil' }), JSON.stringify({ [chain]: 42 })]) {
      assert.throws(() => go(bad), (e) => e.code === 'SITE_EXPLORERS_INVALID', bad);
    }
    const repoListing = requestOf();
    const signed = await signedBy(WALLET, repoListing);
    assert.equal(unpackSiteRequest({ ...signed, maker: WALLET.address, out: tmp(), explorers: '{' }).explorerApiUrl, '', 'a repository listing reads no explorer');
  });

  test('a stolen token names a project\'s maker and a key of its own: without that wallet\'s signature, nothing starts', async () => {
    const signedJson = requestOf();
    const forged = await signedBy(THIEF, signedJson, { address: WALLET.address });
    assert.throws(() => unpackSiteRequest({ ...forged, maker: WALLET.address, out: tmp() }), (e) => e.code === 'MAKER_SIGNATURE_INVALID');
    const honest = await signedBy(WALLET, signedJson);
    assert.throws(() => unpackSiteRequest({ ...honest, maker: THIEF.address, out: tmp() }), (e) => e.code === 'SITE_REQUEST_MAKER_MISMATCH');
    // the wallet signed one request, and the thief sends another with its signature
    const other = requestOf({ spec: { ...draftSpec(), repo: 'https://github.com/thief/other', stake: { ...draftSpec().stake, knownIssues: 'known_issues.json' } } });
    assert.throws(() => unpackSiteRequest({ request: encodeSiteRequest(other), auth: honest.auth, maker: WALLET.address, out: tmp() }), (e) => e.code === 'MAKER_SIGNATURE_INVALID');
  });

  test('the command line reads the environment only, and writes outputs a later step can trust', async () => {
    const signedJson = requestOf();
    const { request, auth } = await signedBy(WALLET, signedJson);
    const dir = tmp();
    const outputs = path.join(dir, 'outputs');
    fs.writeFileSync(outputs, '');
    execFileSync(process.execPath, [SCRIPT, 'unpack', '--out', path.join(dir, 'source')], { env: { PATH: process.env.PATH, SITE_REQUEST: request, SITE_AUTH: auth, MAKER: WALLET.address, GITHUB_OUTPUT: outputs } });
    assert.deepEqual(fs.readFileSync(outputs, 'utf8').trim().split('\n').sort(), ['deployment-proof=', 'explorer-api-url=', 'known-issues=known_issues.json', 'spec=draft.json']);
    const r = spawnSync(process.execPath, [SCRIPT, 'unpack', '--out', path.join(dir, 'other')], { encoding: 'utf8', env: { PATH: process.env.PATH, SITE_REQUEST: '$(curl evil)', SITE_AUTH: auth, MAKER: WALLET.address, GITHUB_OUTPUT: outputs } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SITE_REQUEST_INVALID/);
    assert.equal(fs.existsSync(path.join(dir, 'other')), false);
  });
});

describe('the sign job checks the request again, on a machine the maker\'s code never ran on', () => {
  const publishAs = IMAGE_REPOSITORY;

  test('the same terms, signed by that wallet: it passes', async () => {
    const signedJson = requestOf();
    const { request, auth } = await signedBy(WALLET, signedJson);
    assert.deepEqual(checkSignedFiles({ request, auth, maker: WALLET.address, dir: builtFolder(signedJson), publishAs }).maker, WALLET.address);
  });

  test('a build that changed a term the wallet signed is refused, whatever its report says', async () => {
    const signedJson = requestOf();
    const { request, auth } = await signedBy(WALLET, signedJson);
    for (const edit of [
      (x) => ({ ...x, stake: { ...x.stake, disclosureKey: 'thief' } }),
      (x) => ({ ...x, repo: 'https://github.com/thief/other' }),
      (x) => ({ ...x, baseCommit: 'f'.repeat(40) }),
      (x) => ({ ...x, commands: { ...x.commands, test: 'true' } }),
    ]) {
      assert.throws(() => checkSignedFiles({ request, auth, maker: WALLET.address, dir: builtFolder(signedJson, edit), publishAs }), (e) => e.code === 'SITE_REQUEST_TERMS_CHANGED');
    }
  });

  test('known issues other than the signed bytes, or none, are refused', async () => {
    const signedJson = requestOf();
    const { request, auth } = await signedBy(WALLET, signedJson);
    const dir = builtFolder(signedJson);
    fs.writeFileSync(path.join(dir, 'known_issues.json'), '[]\n');
    assert.throws(() => checkSignedFiles({ request, auth, maker: WALLET.address, dir, publishAs }), (e) => e.code === 'SITE_REQUEST_TERMS_CHANGED');
    fs.rmSync(path.join(dir, 'known_issues.json'));
    assert.throws(() => checkSignedFiles({ request, auth, maker: WALLET.address, dir, publishAs }), (e) => e.code === 'SITE_REQUEST_TERMS_CHANGED');
  });

  test('an image outside the repository this job was told is refused', async () => {
    const signedJson = requestOf();
    const { request, auth } = await signedBy(WALLET, signedJson);
    const dir = builtFolder(signedJson, (x) => ({ ...x, env: { ...x.env, image: `ghcr.io/stranger/env@sha256:${'a'.repeat(64)}` } }));
    assert.throws(() => checkSignedFiles({ request, auth, maker: WALLET.address, dir, publishAs }), (e) => e.code === 'SITE_REQUEST_IMAGE_ELSEWHERE');
  });

  test('another wallet\'s signature is refused here too', async () => {
    const signedJson = requestOf();
    const forged = await signedBy(THIEF, signedJson, { address: WALLET.address });
    assert.throws(() => checkSignedFiles({ ...forged, maker: WALLET.address, dir: builtFolder(signedJson), publishAs }), (e) => e.code === 'MAKER_SIGNATURE_INVALID');
  });

  test('a replay of an old request reproduces what that wallet asked for: no check depends on the clock, or a run deadline would refuse a slow build', async () => {
    const signedJson = requestOf();
    const { request, auth } = await signedBy(WALLET, signedJson);
    const first = checkSignedFiles({ request, auth, maker: WALLET.address, dir: builtFolder(signedJson), publishAs });
    assert.equal(checkSignedFiles({ request, auth, maker: WALLET.address, dir: builtFolder(signedJson), publishAs }).maker, first.maker);
  });

  test('in the workflow: required, checked before the signer is near, with the job\'s own inputs through the environment', () => {
    const { inputs } = signer.on.workflow_call;
    for (const k of ['site-request', 'site-auth']) assert.equal(inputs[k].required, true, k);
    const all = signer.jobs.sign.steps;
    const check = all.findIndex((s) => /site-request\.js" check --dir "\$VAB_OUT" --publish-as "\$PUBLISH_REPOSITORY"/.test(s.run ?? ''));
    const download = all.findIndex((s) => String(s.uses ?? '').startsWith('actions/download-artifact@'));
    const sign = all.findIndex((s) => /verdikta-build-env\.js" sign\b/.test(s.run ?? ''));
    assert.ok(download < check && check < sign, `${download} ${check} ${sign}`);
    assert.equal(all[check].env.SITE_REQUEST, '${{ inputs.site-request }}');
    assert.equal(all[check].env.SITE_AUTH, '${{ inputs.site-auth }}');
    assert.equal(JSON.stringify(all[check]).includes('secrets.'), false);
    assert.equal(all[check].if, undefined);
  });

  test('production signing starts by workflow_dispatch alone, the caller\'s only trigger', () => {
    assert.match(signer.jobs.sign.steps[0].run, /workflow_dispatch\)/);
    assert.doesNotMatch(signer.jobs.sign.steps[0].run, /repository_dispatch/);
  });
});

describe('the maker\'s text in a step\'s output', () => {
  test('no line of it can be taken for a workflow command', () => {
    for (const hostile of ['::set-output name=image::evil', '  ::add-mask::x', '\t::stop-commands::t', '##[set-output name=image;]evil', 'text ##[add-mask]x', 'a\r::set-output name=x::y', 'a\n::error::x\nb']) {
      const out = neutralize(hostile);
      for (const line of out.split('\n')) {
        assert.doesNotMatch(line, /^\s*::/, hostile);
        assert.doesNotMatch(line, /##\[/, hostile);
        assert.doesNotMatch(line, /\r/, hostile);
      }
    }
    assert.equal(neutralize('accepted: ghcr.io/verdikta/stake-env@sha256:ab; see x::y\n'), 'accepted: ghcr.io/verdikta/stake-env@sha256:ab; see x::y\n');
  });

  test('the command line\'s every write goes through the filter', async () => {
    const lines = { out: '', err: '' };
    const code = await main(['digest', '--dir', '/nonexistent\n::set-output name=image::evil\n##[set-output name=image;]evil'], { stdout: { write: (s) => { lines.out += s; } }, stderr: { write: (s) => { lines.err += s; } } });
    assert.notEqual(code, 0);
    for (const line of `${lines.out}\n${lines.err}`.split('\n')) {
      assert.doesNotMatch(line, /^\s*::/);
      assert.doesNotMatch(line, /##\[/);
    }
  });
});
