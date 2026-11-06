// The client's pages in a real browser, reading what the round did: the record and the feed.
// Read-only: the maker's and hunter's actions go through the API, the tool and a plain wallet here, and
// the client's own wallet flows have their Playwright tests against this same contract (node P6b).
export async function readPages(chromium, clientUrl, { artifactHash, listingId, onBrowser = () => {} }) {
  // The round's own stop closes it (onBrowser): Playwright's handlers would act on a signal by themselves.
  const browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  onBrowser(browser);
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const text = (testId) => page.getByTestId(testId).innerText({ timeout: 30000 });
    await page.goto(`${clientUrl}/#/record/${artifactHash}`);
    await page.getByTestId('record-hash').waitFor({ timeout: 60000 });
    const record = {
      hash: await text('record-hash'),
      claims: await text('history-claims'),
      judged: await text('history-judged'),
      pending: await text('history-pending'),
      verdicts: await text('history-verdicts'),
      released: await text('history-released'),
      noVerdict: await text('history-no-verdict'),
      integrity: await text('history-integrity'),
      integrityChecks: await page.getByTestId('history-integrity-checks').innerText({ timeout: 5000 }).catch(() => ''),
      integrityOther: await text('history-duplicates'),
      integrityNote: await text('integrity-note'),
      findings: await text('record-findings'),
      state: await text(`listing-${listingId}-state`),
      main: await page.locator('main').innerText(),
    };
    await page.goto(`${clientUrl}/#/feed`);
    await page.getByTestId(`feed-${listingId}`).waitFor({ timeout: 60000 });
    const feed = await page.getByTestId(`feed-${listingId}`).innerText();
    return { record, feed, errors };
  } finally {
    await browser.close();
  }
}
