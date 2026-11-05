// Run by test/workflow.production.test.js under test/helpers/trustStub.cjs: one listing through the real
// flow against the GitHub stub, with common's real production verification over its stubbed set.
import crypto from 'node:crypto';

import { MAKER, listingRequest } from '../helpers/fixtures.js';
import { startGithubStub, SUCCESS } from '../helpers/githubStub.js';
import { startApi } from '../helpers/http.js';
import { fakeScanner } from '../helpers/scan.js';
import { LISTING_ARTIFACT, SIGNED_ARTIFACT, signedListing, workflowConfig, workflowEnv, zipOf } from '../helpers/workflowRun.js';

const privateKey = crypto.createPrivateKey(process.env.TEST_PRIVATE_KEY_PEM);
const body = listingRequest();
const { folder, report } = await signedListing({ draft: body.spec, privateKey });
const statuses = process.env.TEST_REVIEWERS === 'on'
  ? ['queued', 'in_progress', 'waiting', 'waiting', 'in_progress', SUCCESS]
  : ['queued', 'in_progress', 'in_progress', SUCCESS];
const stub = await startGithubStub({
  script: () => ({ statuses, artifacts: { [SIGNED_ARTIFACT]: zipOf(folder), [LISTING_ARTIFACT]: zipOf({ 'validation-report.json': JSON.stringify(report) }) } }),
});
const env = workflowEnv(stub);
const scanner = fakeScanner();
const s = await startApi({ config: workflowConfig(stub, env), env, scanner });
const submitted = await s.submit(body);
const { id } = await submitted.json();
const seen = new Set();
for (;;) {
  const view = await (await s.get(`/api/listings/${id}`)).json();
  seen.add(view.status);
  if (['ready', 'refused', 'error'].includes(view.status)) {
    process.stdout.write(`${JSON.stringify({ view, seen: [...seen], dispatches: stub.state.dispatches.length, maker: MAKER, pinned: s.pinner.pins?.size ?? null })}\n`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1));
}
s.app.buildRuns?.stop();
await s.close();
await stub.close();
