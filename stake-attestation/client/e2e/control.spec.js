// Node P8, on the page: per listing, the fact "staker controls the repository: yes / no" with what
// proves it, so anyone can re-check; the badge states it; no proof, a failed check or a listing the
// site cannot read is "no"; nothing refuses a listing for that; and a contract listing's owner signs
// from the record page. The server's real check runs (builder/bin/verdikta-control-check.js) over
// real git against bare repositories in the stack's mirror folder: no network.
import { STRINGS, fill } from '../src/strings.js';
import { disclosure, expect, fromServer, installWallet, shot, test } from './support/fixtures.js';
import { wordingProblems } from './support/wording.js';

const C = STRINGS.control;
let counter = 0;
const nextRepo = (stack) => `https://github.com/acme/control-${process.pid}-${(counter += 1)}-${stack.chainId}`;

async function factFromServer(stack, hash, listingId) {
  const res = await fetch(`${stack.apiUrl}/api/records/${hash}`);
  return res.ok ? (await res.json()).control?.[String(listingId)] ?? null : null;
}

const checked = (chain, stack, hash, listingId) => chain.until(async () => (await factFromServer(stack, hash, listingId))?.checkedAt > 0, { what: `the control check of listing ${listingId}` });

test('a repository listing: the file names the maker, on a branch: "yes", with what proves it; a stranger\'s listing of the same hash: "no"; the badge states it', async ({ page, stack, chain }) => {
  test.setTimeout(180_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const commit = repo.commit({ file: proofFile(stack.accounts.maker) });
  const key = disclosure.generateDisclosureKeyPair();
  const mine = await chain.openListing({ recipient: key.recipient, baseCommit: commit, spec: { repo: repo.url }, stake: { valueAtRiskUsd: undefined } });
  const theirs = await chain.openListing({ recipient: key.recipient, baseCommit: commit, spec: { repo: repo.url }, maker: stack.accounts.other, stake: { valueAtRiskUsd: undefined } });
  expect(theirs.artifactHash).toBe(mine.artifactHash);
  await checked(chain, stack, mine.artifactHash, mine.listingId);

  await page.goto(`/#/record/${mine.artifactHash}`);
  const s = (id, f) => page.getByTestId(`listing-${id}-${f}`);
  await expect(s(mine.listingId, 'control')).toHaveText(C.yes);
  await expect(page.getByTestId(`listing-${mine.listingId}`)).toContainText(C.repository);
  await expect(s(mine.listingId, 'control-why')).toHaveCount(0);
  // what proves it, to re-check by hand
  const proof = s(mine.listingId, 'control-proof');
  await expect(proof).toContainText('.verdikta/stake-control.json');
  await expect(proof).toContainText(commit);
  await expect(proof).toContainText(stack.accounts.maker);
  await expect(proof).toContainText('refs/heads/main');
  await expect(proof).toContainText(`git clone --bare --filter=tree:0 ${repo.url} check.git`);
  await expect(proof).toContainText(`git -C check.git for-each-ref --contains ${commit} refs/heads refs/tags`);

  // the stranger's stake: allowed, and labelled
  await expect(s(theirs.listingId, 'state')).toHaveText(STRINGS.enums.listingStates.Open);
  await expect(s(theirs.listingId, 'control')).toHaveText(C.no);
  await expect(s(theirs.listingId, 'control-why')).toContainText('names another address');
  await expect(s(theirs.listingId, 'control-proof')).toContainText(stack.accounts.maker);

  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'control-repository', { target: page.getByTestId(`listing-${mine.listingId}`) });

  // the badge states the fact of the listing it shows
  const svg = await (await page.request.get(`/api/records/${mine.artifactHash}/badge.svg`)).text();
  expect(svg).toContain('staker controls the repository: yes');
  await shot(page, 'control-badge', { target: page.getByTestId('badge-panel') });

  // the feed says it too
  await page.goto('/#/feed');
  await expect(page.getByTestId(`feed-${mine.listingId}-control`)).toHaveText(C.yes);
  await expect(page.getByTestId(`feed-${theirs.listingId}-control`)).toHaveText(C.no);
});

test('imposter commit: a fork-only commit whose file names the stranger is "no", and the page says why', async ({ page, stack, chain }) => {
  test.setTimeout(120_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const forked = repo.commit({ file: proofFile(stack.accounts.other), branch: null });
  repo.pullRef(forked);
  const key = disclosure.generateDisclosureKeyPair();
  const l = await chain.openListing({ recipient: key.recipient, baseCommit: forked, spec: { repo: repo.url }, maker: stack.accounts.other, stake: { valueAtRiskUsd: undefined } });
  await checked(chain, stack, l.artifactHash, l.listingId);

  await page.goto(`/#/record/${l.artifactHash}`);
  const s = (f) => page.getByTestId(`listing-${l.listingId}-${f}`);
  await expect(s('control')).toHaveText(C.no);
  await expect(s('control-why')).toContainText('not on any of the repository\'s own branches or tags');
  await expect(s('control-proof')).toContainText(C.onRefsNo);
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'control-imposter', { target: page.getByTestId(`listing-${l.listingId}`) });
  const svg = await (await page.request.get(`/api/records/${l.artifactHash}/badge.svg`)).text();
  expect(svg).toContain('staker controls the repository: no');
});

test('no proof, and a host the site cannot read, are "no" with the reason; the listing stands', async ({ page, stack, chain }) => {
  test.setTimeout(120_000);
  const key = disclosure.generateDisclosureKeyPair();
  const missing = await chain.openListing({ recipient: key.recipient, stake: { valueAtRiskUsd: undefined } });
  const lookalike = await chain.openListing({ recipient: key.recipient, spec: { repo: 'https://github.com.evil.example/acme/vault' }, stake: { valueAtRiskUsd: undefined } });
  await checked(chain, stack, missing.artifactHash, missing.listingId);
  await chain.until(async () => (await factFromServer(stack, lookalike.artifactHash, lookalike.listingId)) !== null, { what: 'the look-alike\'s record' });

  await page.goto(`/#/record/${missing.artifactHash}`);
  await expect(page.getByTestId(`listing-${missing.listingId}-control`)).toHaveText(C.no);
  await expect(page.getByTestId(`listing-${missing.listingId}-control-why`)).toContainText('could not be read');
  await page.goto(`/#/record/${lookalike.artifactHash}`);
  await expect(page.getByTestId(`listing-${lookalike.listingId}-control`)).toHaveText(C.no);
  await expect(page.getByTestId(`listing-${lookalike.listingId}-control-why`)).toContainText('does not read repositories on this host');
  await expect(page.getByTestId('record-repo')).toHaveText('https://github.com.evil.example/acme/vault');
  // no command to paste for a URL the site would not read
  await expect(page.getByTestId(`listing-${lookalike.listingId}-control-proof`)).not.toContainText('git clone');
});

test('a contract listing: a repository file alone is "no"; a stranger\'s signature is refused; the owner signs on the record page and it is "yes", with what proves it', async ({ page, stack, chain }) => {
  test.setTimeout(180_000);
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  const repo = makeRepo(stack.mirrorDir, nextRepo(stack));
  const commit = repo.commit({ file: proofFile(stack.accounts.maker) });
  const key = disclosure.generateDisclosureKeyPair();
  const l = await chain.openListing({
    recipient: key.recipient,
    baseCommit: commit,
    spec: { repo: repo.url, artifact: { kind: 'contract', address: stack.ownedContract, chainId: stack.chainId } },
    stake: { valueAtRiskUsd: undefined },
  });
  await checked(chain, stack, l.artifactHash, l.listingId).catch(() => {});
  await chain.until(async () => (await factFromServer(stack, l.artifactHash, l.listingId))?.repository?.checkedAt > 0, { what: 'the repository check' });

  await installWallet(page, stack, stack.accounts.hunter);
  await page.goto(`/#/record/${l.artifactHash}`);
  const s = (f) => page.getByTestId(`listing-${l.listingId}-${f}`);
  await expect(page.getByTestId(`listing-${l.listingId}`)).toContainText(C.deployment);
  await expect(s('control')).toHaveText(C.no);
  await expect(s('control-why')).toContainText('No signature');
  await expect(s('control-repository')).toContainText(C.fileNames.split('{')[0]);
  const form = page.getByTestId(`control-form-${l.listingId}`);
  const message = await form.getByTestId('control-message').inputValue();
  expect(message).toContain(`Maker: ${stack.accounts.maker}`);
  expect(message).toContain(`Artifact Hash: ${l.artifactHash.toLowerCase()}`);
  expect(message).toContain(`Chain Id: ${stack.chainId}`);
  await shot(page, 'control-contract-no', { target: page.getByTestId(`listing-${l.listingId}`) });

  // a stranger's wallet signs: the server refuses it, and the fact stays "no"
  await form.getByRole('button', { name: C.sign }).click();
  await expect(form.getByTestId('control-signer')).toHaveValue(stack.accounts.hunter);
  await form.getByRole('button', { name: C.send }).click();
  await expect(form.getByRole('alert')).toContainText('SIGNER_NOT_CONTROLLER');
  await expect(s('control')).toHaveText(C.no);

  // the deployment's owner signs
  await page.evaluate((a) => window.__testWallet.setAccount(a), stack.accounts.other);
  await form.getByRole('button', { name: C.sign }).click();
  await expect(form.getByTestId('control-signer')).toHaveValue(stack.accounts.other);
  await form.getByRole('button', { name: C.send }).click();
  await expect(s('control')).toHaveText(C.yes, { timeout: 30_000 });
  const proof = s('control-proof');
  await expect(proof).toContainText(stack.accounts.other);
  await expect(proof).toContainText(C.roles.owner);
  await expect(proof).toContainText(`cast call ${stack.ownedContract} "owner()(address)"`);
  await expect(page.getByTestId(`control-form-${l.listingId}`)).toHaveCount(0);
  expect(wordingProblems(await page.locator('main').innerText())).toEqual([]);
  await shot(page, 'control-contract-yes', { target: page.getByTestId(`listing-${l.listingId}`) });

  const svg = await (await page.request.get(`/api/records/${l.artifactHash}/badge.svg`)).text();
  expect(svg).toContain('staker controls the deployment: yes');
});

test('the listing form says how to prove control and that nothing requires it', async ({ page }) => {
  await page.goto('/#/list');
  await expect(page.getByText(fill(STRINGS.listing.hints.control, {}))).toBeVisible();
});
