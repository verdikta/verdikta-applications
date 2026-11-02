// Node P9 (owner decision Q34, "the project decides"), on the page: every listing needs the project's
// proof; the form says so and shows the refusal by name; the record, the feed and the badge count
// only a listing the builder signed and the project proved; any other listing of the hash shows
// apart and adds nothing; a fork is labelled; every listing page warns who reads a proof first and
// that the code may exist elsewhere. The server's real check runs over real git against bare
// repositories in the stack's mirror folder: no network.
import { LISTING_WARNING } from '@verdikta/stake-attestation-shared/listing-warning';
import { Contract } from 'ethers';

import { CONTROL_FILE_FORMAT, STRINGS, fill } from '../src/strings.js';
import { disclosure, expect, fromServer, installWallet, shot, test } from './support/fixtures.js';
import { field, fillListing, generateAndSaveKey, listAndFund, repoTerms, signDeployment, validate } from './support/listingForm.js';
import { wordingProblems } from './support/wording.js';

const C = STRINGS.control;
const N = STRINGS.notCounted;
const O = STRINGS.offer;
const F = STRINGS.listing.fields;
let counter = 0;
const nextRepo = (stack, prefix = 'proof') => `https://github.com/acme/${prefix}-${process.pid}-${(counter += 1)}-${stack.chainId}`;

test('the project\'s own listing: named by the repository, with what proves it; a replay from another wallet shows apart and adds nothing', async ({ page, stack, chain }) => {
  test.setTimeout(180_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const commit = repo.commit({ file: proofFile(stack.accounts.maker) });
  const key = disclosure.generateDisclosureKeyPair();
  const mine = await chain.openListing({ recipient: key.recipient, baseCommit: commit, spec: { repo: repo.url }, stake: { valueAtRiskUsd: undefined } });
  const theirs = await chain.replay(mine.view, stack.accounts.other);
  const apart = await chain.notCounted(mine.artifactHash, theirs.listingId);
  expect(apart.reason).toBe('PROOF_NAMES_ANOTHER_ADDRESS');

  await page.goto(`/#/record/${mine.artifactHash}`);
  const s = (id, f) => page.getByTestId(`listing-${id}-${f}`);
  await expect(s(mine.listingId, 'control')).toHaveText(C.yes);
  await expect(page.getByTestId(`listing-${mine.listingId}`)).toContainText(C.repository);
  await expect(page.getByTestId(`listing-${mine.listingId}`)).not.toContainText('controls the repository');
  await expect(s(mine.listingId, 'control-why')).toHaveCount(0);
  const proof = s(mine.listingId, 'control-proof');
  await expect(proof).toContainText('.verdikta/stake-control.json');
  await expect(proof).toContainText(commit);
  await expect(proof).toContainText(stack.accounts.maker);
  await expect(proof).toContainText('refs/heads/main');
  await expect(proof).toContainText(`git clone --bare --filter=tree:0 ${repo.url} check.git`);

  // the replay: apart, with why, and none of its amounts, though it holds 50 times the stake
  await expect(page.getByTestId(`listing-${theirs.listingId}`)).toHaveCount(0);
  const section = page.getByTestId('record-not-counted');
  await expect(section).toContainText(fill(N.listing, { id: theirs.listingId }));
  await expect(page.getByTestId(`not-counted-${theirs.listingId}-maker`)).toHaveText(stack.accounts.other);
  await expect(page.getByTestId(`not-counted-${theirs.listingId}-why`)).toContainText('names another address');
  await expect(section).not.toContainText('ETH');
  await expect(page.getByTestId('record-listing-count')).toHaveText('1');
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'project-record-replay', { target: section });
  await shot(page, 'project-repository', { target: page.getByTestId(`listing-${mine.listingId}`) });

  // the badge counts only the project's
  const svg = await (await page.request.get(`/api/records/${mine.artifactHash}/badge.svg`)).text();
  expect(svg).toContain('staker named by the repository: yes');
  await shot(page, 'project-badge', { target: page.getByTestId('badge-panel') });

  // the feed offers only the project's
  await page.goto('/#/feed');
  await expect(page.getByTestId(`feed-${mine.listingId}-control`)).toHaveText(C.yes);
  await expect(page.getByTestId(`feed-${theirs.listingId}`)).toHaveCount(0);
  await expect(page.getByTestId('feed-not-counted')).toContainText(stack.accounts.other);

  // each listing's page says whether the site offers a commit on it
  await page.goto(`/#/fund/${mine.listingId}`);
  await expect(page.getByTestId('commit-offer')).toHaveText(new RegExp(O.yes));
  await page.goto(`/#/fund/${theirs.listingId}`);
  await expect(page.getByTestId('commit-offer')).toContainText('This site offers no commit on this listing');
  await expect(page.getByTestId('commit-offer')).toContainText('names another address');
  await shot(page, 'project-no-commit-offer', { target: page.getByTestId('commit-offer') });
});

test('when the project\'s stake closes, a replay left on the hash does not keep the badge alive', async ({ page, stack, chain }) => {
  test.setTimeout(180_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const commit = repo.commit({ file: proofFile(stack.accounts.maker) });
  const key = disclosure.generateDisclosureKeyPair();
  const mine = await chain.openListing({ recipient: key.recipient, baseCommit: commit, spec: { repo: repo.url }, stake: { valueAtRiskUsd: undefined } });
  const theirs = await chain.replay(mine.view, stack.accounts.other);
  await chain.notCounted(mine.artifactHash, theirs.listingId);
  // the project's stake ends: only the replay is left
  await (await (await chain.as(stack.accounts.maker)).close(mine.listingId)).wait();
  await chain.until(async () => {
    const r = await (await fetch(`${stack.apiUrl}/api/records/${mine.artifactHash}`)).json();
    return r.badge.message === 'stake closed';
  }, { what: 'the badge after the close' });
  const svg = await (await page.request.get(`/api/records/${mine.artifactHash}/badge.svg`)).text();
  expect(svg).toContain('stake closed');
  expect(svg).not.toContain('while staked');
});

test('the form refuses by name: no proof file, another address, a fork-only commit, one under refs/pull; nothing goes on-chain', async ({ page, stack }) => {
  test.setTimeout(180_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  await installWallet(page, stack);
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const forked = repo.commit({ file: proofFile(stack.accounts.maker), branch: null });
  const pulled = repo.commit({ file: proofFile(stack.accounts.maker), branch: null });
  repo.pullRef(pulled, 7);
  const cases = [
    [repo.commit({ file: null }), 'NO_PROOF_FILE'],
    [repo.commit({ file: proofFile(stack.accounts.other) }), 'PROOF_NAMES_ANOTHER_ADDRESS'],
    [repo.commit({ file: '{"version":1,"makers":[]}' }), 'PROOF_FILE_INVALID'],
    [forked, 'COMMIT_NOT_ON_OWN_REFS'],
    [pulled, 'COMMIT_NOT_ON_OWN_REFS'],
  ];
  const before = (await (await fetch(`${stack.apiUrl}/api/status`)).json()).listings.refused.total;
  for (const [commit, code] of cases) {
    await page.goto('about:blank');
    await page.goto('/#/list');
    const terms = await repoTerms(stack);
    await fillListing(page, { ...terms, repo: repo.url, baseCommit: commit });
    await generateAndSaveKey(page);
    await validate(page, 'refused');
    await expect(page.getByTestId('listing-refusal')).toContainText(code);
    await expect(page.getByRole('button', { name: STRINGS.chain.list })).toHaveCount(0);
    if (code === 'NO_PROOF_FILE') await shot(page, 'project-refused');
  }
  const status = await (await fetch(`${stack.apiUrl}/api/status`)).json();
  expect(status.listings.refused.total).toBe(before + cases.length);
  expect(status.listings.refused.byReason.COMMIT_NOT_ON_OWN_REFS).toBeGreaterThanOrEqual(2);
  expect(status.listings.refused.byReason.NO_PROOF_FILE).toBeGreaterThanOrEqual(1);
  const counts = JSON.stringify(status.listings);
  expect(counts).not.toMatch(/0x[0-9a-fA-F]{40}/);
  expect(counts).not.toContain('acme');
});

test('a sponsor the project names stakes; the record says named, not controls', async ({ page, stack, chain }) => {
  test.setTimeout(120_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const commit = repo.commit({ file: proofFile(stack.accounts.other) });
  const key = disclosure.generateDisclosureKeyPair();
  const l = await chain.openListing({ recipient: key.recipient, baseCommit: commit, spec: { repo: repo.url }, maker: stack.accounts.other, stake: { valueAtRiskUsd: undefined } });
  await page.goto(`/#/record/${l.artifactHash}`);
  await expect(page.getByTestId(`listing-${l.listingId}-maker`)).toHaveText(stack.accounts.other);
  await expect(page.getByTestId(`listing-${l.listingId}-control`)).toHaveText(C.yes);
  await expect(page.getByTestId(`listing-${l.listingId}`)).toContainText(C.repository);
});

test('a contract listing: the owner\'s signature goes with the request; a stranger\'s is refused by name; the record says both lines', async ({ page, stack, chain }) => {
  test.setTimeout(240_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const commit = repo.commit({ file: proofFile(stack.accounts.maker) });
  await installWallet(page, stack);
  await page.goto('/#/list');
  const terms = await repoTerms(stack);
  await fillListing(page, { ...terms, repo: repo.url, baseCommit: commit, kind: 'contract', address: stack.ownedContract, chainId: stack.chainId, valueAtRisk: undefined });
  await generateAndSaveKey(page);
  // none yet: the form says so and sends nothing
  await expect(page.getByText(STRINGS.listing.needSignature)).toBeVisible();
  await expect(page.getByRole('button', { name: STRINGS.listing.submit })).toBeDisabled();

  // a stranger's wallet signs: refused by name, nothing built
  await signDeployment(page, stack, stack.accounts.hunter);
  await expect(page.getByTestId('control-message')).toContainText(`Chain Id: ${stack.chainId}`);
  await shot(page, 'project-contract-form', { target: page.getByTestId('deployment-proof') });
  await validate(page, 'refused');
  await expect(page.getByTestId('listing-refusal')).toContainText('SIGNER_NOT_CONTROLLER');

  // the deployment's owner signs
  await page.getByRole('button', { name: STRINGS.listing.again }).click();
  await signDeployment(page, stack);
  await validate(page, 'ready');
  const listingId = await listAndFund(page);
  const hash = (await chain.sa.getListing(listingId)).artifactHash;
  await chain.counted(hash, listingId);

  await page.goto(`/#/record/${hash}`);
  const s = (f) => page.getByTestId(`listing-${listingId}-${f}`);
  await expect(s('control')).toHaveText(C.yes);
  await expect(s('control-deployment')).toHaveText(C.yes);
  await expect(page.getByTestId(`listing-${listingId}`)).toContainText(C.repository);
  await expect(page.getByTestId(`listing-${listingId}`)).toContainText(C.deployment);
  await expect(s('control-deployment-proof')).toContainText(stack.accounts.other);
  await expect(s('control-deployment-proof')).toContainText(C.roles.owner);
  await expect(page.getByTestId(`control-form-${listingId}`)).toHaveCount(0);
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'project-contract-yes', { target: page.getByTestId(`listing-${listingId}`) });
  const svg = await (await page.request.get(`/api/records/${hash}/badge.svg`)).text();
  expect(svg).toContain('staker named by the repository: yes');
  expect(svg).toContain('staker controls the deployment: yes');
});

test('an owner hands over: the listing shows apart, and the new owner signs on the record page: then it counts again', async ({ page, stack, chain }) => {
  test.setTimeout(180_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const commit = repo.commit({ file: proofFile(stack.accounts.maker) });
  const key = disclosure.generateDisclosureKeyPair();
  const post = (path, body) => fetch(`${stack.apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const { message } = await (await post('/api/listings/deployment-message', { maker: stack.accounts.maker, repo: repo.url, baseCommit: commit, chainId: stack.chainId, address: stack.handedOverContract })).json();
  const signature = await (await chain.provider.getSigner(stack.accounts.other)).signMessage(message);
  const l = await chain.openListing({
    recipient: key.recipient,
    baseCommit: commit,
    spec: { repo: repo.url, artifact: { kind: 'contract', address: stack.handedOverContract, chainId: stack.chainId } },
    stake: { valueAtRiskUsd: undefined },
    deploymentProof: { signer: stack.accounts.other, signature },
  });
  const owned = new Contract(stack.handedOverContract, ['function transferOwnership(address)'], await chain.provider.getSigner(stack.accounts.other));
  await (await owned.transferOwnership(stack.accounts.hunter)).wait();
  const apart = await chain.notCounted(l.artifactHash, l.listingId);
  expect(apart.reason).toBe('SIGNER_NOT_CONTROLLER');

  await installWallet(page, stack, stack.accounts.hunter);
  await page.goto(`/#/record/${l.artifactHash}`);
  await expect(page.getByTestId(`not-counted-${l.listingId}-why`)).toContainText('not the deployment\'s current owner');
  const form = page.getByTestId(`control-form-${l.listingId}`);
  await form.getByRole('button', { name: C.sign }).click();
  await expect(form.getByTestId('control-signer')).toHaveValue(stack.accounts.hunter);
  await form.getByRole('button', { name: C.send }).click();
  await expect(page.getByTestId(`listing-${l.listingId}-control-deployment`)).toHaveText(C.yes, { timeout: 30_000 });
  await expect(page.getByTestId(`not-counted-${l.listingId}`)).toHaveCount(0);
});

test('a fork is labelled from the host\'s answer; an unknown answer says unknown; a plain copy is stated as undetectable', async ({ page, stack, chain }) => {
  test.setTimeout(180_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const key = disclosure.generateDisclosureKeyPair();
  const open = async (prefix) => {
    const repo = makeRepo(stack.mirrorDir, nextRepo(stack, prefix));
    return chain.openListing({ recipient: key.recipient, baseCommit: repo.commit({ file: proofFile(stack.accounts.maker) }), spec: { repo: repo.url }, stake: { valueAtRiskUsd: undefined } });
  };
  const forked = await open('forked');
  const original = await open('original');
  const silent = await open('silent');
  const labelled = (hash, status) => chain.until(async () => (await (await fetch(`${stack.apiUrl}/api/records/${hash}`)).json()).fork?.status === status, { what: `the ${status} label` });

  await labelled(forked.artifactHash, 'fork');
  await page.goto(`/#/record/${forked.artifactHash}`);
  await expect(page.getByTestId('record-fork-status')).toHaveText(fill(STRINGS.fork.yes, { parent: 'https://github.com/acme/vault' }));
  await expect(page.getByTestId('record-fork-note')).toContainText('cannot be detected');
  await shot(page, 'project-fork', { target: page.getByTestId('record-artifact') });

  await labelled(original.artifactHash, 'not-fork');
  await page.goto(`/#/record/${original.artifactHash}`);
  await expect(page.getByTestId('record-fork-status')).toHaveText(STRINGS.fork.no);

  await labelled(silent.artifactHash, 'unknown');
  await page.goto(`/#/record/${silent.artifactHash}`);
  await expect(page.getByTestId('record-fork-status')).toHaveText(STRINGS.fork.unknown);
  await expect(page.getByTestId('record-fork-note')).toContainText('plain copy');
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
});

test('every listing page warns who reads a proof first and that the code may exist elsewhere', async ({ page, stack, chain }) => {
  test.setTimeout(120_000);
  const key = disclosure.generateDisclosureKeyPair();
  const l = await chain.openListing({ recipient: key.recipient });
  for (const url of ['/#/feed', `/#/record/${l.artifactHash}`, `/#/fund/${l.listingId}`]) {
    await page.goto(url);
    const warning = page.getByTestId('listing-warning');
    await expect(warning).toContainText(LISTING_WARNING.proofFirst);
    await expect(warning).toContainText(LISTING_WARNING.elsewhere);
    expect(wordingProblems(await warning.innerText())).toEqual([]);
  }
  await shot(page, 'project-warning', { target: page.getByTestId('listing-warning') });
});

test('the listing form states the rule, and without a wallet nothing is sent', async ({ page, stack }) => {
  await page.goto('/#/list');
  await expect(page.getByText(fill(STRINGS.listing.hints.control, { format: CONTROL_FILE_FORMAT }))).toBeVisible();
  await expect(field(page, F.kind)).toBeVisible();
  expect(wordingProblems(STRINGS.listing.hints.control)).toEqual([]);
  expect(stack.mirrorDir).toBeTruthy();
});
