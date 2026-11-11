// check (design §8.6): the arbiters' code-runner pipeline minus the jury, on this machine, against the listing's
// image by digest. The request is what the External Adapter sends for this claim
// (external-adapter/src/codeReview/runnerClient.js, buildRunRequest): the same report cut, the same dropped
// fix.patch, the prior valid findings, whose summaries are in the pack. Nothing is pinned or signed; a plain CID of
// the local archive stands in for the bCID, which only labels the run.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { readSignedListing } from '@verdikta/stake-attestation-shared/builder-signature';
import { readZipMember, zipDirectory } from '@verdikta/stake-attestation-shared/zip-read';

import { buildClaimArchive, cutText, maxPatchBytes, parseFinding, pocProblem, readClaimInputs, reportProblem } from './archive.js';
import { codeReview } from './common.js';
import { fail } from './errors.js';
import { buildForecast, gate } from './forecast.js';
import { fetchArchive, inspectListing, runnerFilesOf } from './listing.js';
import { isCidShaped, rawCid } from './ipfs.js';
import { lintObservable } from './observable.js';
import { REMOTE_RUNNER_NOTICE } from './notices.js';
import { requirementWarnings } from './report.js';

/** What an arbiter gives a run at most: the EA's deadline is receipt + 780 s. */
const RUN_DEADLINE_MS = 780_000;
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
const PRIOR_REPORT_MAX_CHARS = 4096;
const BYTES_PER_PACK_TOKEN = 4;
const CODE_CLASS = 'code-standard';
const PRIOR_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** This machine, by address: a name that merely starts with 127. can resolve anywhere. */
function isLoopback(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
}

/**
 * POST with node's own client: a run can take longer than the five minutes fetch waits for headers. The token goes
 * to this address only (redirects are not followed), and the answer is held to a byte cap.
 */
function postRun(endpoint, token, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = endpoint.protocol === 'https:' ? https : http;
    const req = client.request(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) {
          req.destroy();
          reject(fail('RUNNER_ANSWER_INVALID'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(fail('RUNNER_UNREACHABLE')));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => reject(fail('RUNNER_UNREACHABLE')));
    req.end(payload);
  });
}

async function callRunner(ctx, request) {
  const endpoint = new URL('/v1/runs', ctx.runner.url);
  const res = await postRun(endpoint, ctx.runner.token, JSON.stringify(request), request.deadline + 60_000);
  if (res.status === 401) throw fail('RUNNER_UNAUTHORIZED');
  if (res.status === 413) throw fail('RUNNER_BODY_TOO_LARGE');
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw fail('RUNNER_ANSWER_INVALID', `HTTP ${res.status}.`);
  }
  const known = (res.status === 200 && body?.outcome === 'definitive') || (res.status === 503 && body?.outcome === 'abstain') || (res.status === 400 && body?.outcome === 'requester_error');
  if (!known) throw fail('RUNNER_ANSWER_INVALID', `HTTP ${res.status}.`);
  return { status: res.status, body };
}

/** Prior valid findings, as the contract's request would carry them: the most recent, oldest first. */
async function readPriorFindings(ctx, listingId) {
  const ids = await ctx.read('validFindings', [listingId]);
  const recent = [...ids].slice(-codeReview.MAX_PRIOR_FINDINGS);
  const findings = [];
  const unread = [];
  for (const id of recent) {
    const { bcid } = await ctx.read('getClaim', [id]);
    try {
      const bytes = await fetchArchive(ctx, bcid, { maxBytes: PRIOR_ARCHIVE_MAX_BYTES });
      const entries = zipDirectory(bytes);
      const member = (name) => readZipMember(bytes, entries.get(name), PRIOR_ARCHIVE_MAX_BYTES);
      const finding = JSON.parse(utf8.decode(member(codeReview.FINDING_FILE)));
      if (!codeReview.validateFinding(finding).ok) throw new Error('invalid');
      findings.push({ bcid, finding, report: cutText(utf8.decode(member(codeReview.REPORT_FILE)), PRIOR_REPORT_MAX_CHARS) });
    } catch {
      unread.push(bcid);
    }
  }
  return { findings, unread, total: ids.length };
}

/**
 * @param {object} ctx
 * @param {{ claimDir: string, listingId?: bigint|number, listingArchive?: Buffer, deadlineMs?: number }} o
 */
export async function runCheck(ctx, { claimDir, listingId, listingArchive, deadlineMs = RUN_DEADLINE_MS }) {
  // The address first: nothing is read for a runner this run would refuse.
  let runnerUrl;
  try {
    runnerUrl = new URL(ctx.runner?.url);
  } catch {
    throw fail('RUNNER_NOT_CONFIGURED');
  }
  if (!ctx.runner?.token) throw fail('RUNNER_NOT_CONFIGURED');
  if (ctx.runner.allowRemote) ctx.notice(REMOTE_RUNNER_NOTICE);
  else if (!isLoopback(runnerUrl)) throw fail('RUNNER_NOT_LOCAL');

  let listing;
  let priorFindings = { read: 0, unread: [], total: null };
  let priors = [];
  const local = [];
  const fileNotes = [];
  if (listingArchive !== undefined) {
    const read = readSignedListing(Buffer.from(listingArchive), { codeReview, devKeys: ctx.devKeys?.length ? ctx.devKeys : null });
    if (!read.spec) throw fail('LISTING_ARCHIVE_INVALID');
    listing = { spec: read.spec, listingBytes: Buffer.from(listingArchive), listingCid: rawCid(listingArchive), refusal: read.signed ? null : read.reason };
    fileNotes.push('Read from a file, so this pack holds no prior findings: arbiters send the listing\'s prior valid findings with a claim.');
    local.push(gate('listingSigned', read.signed ? 'pass' : 'fail', read.signed ? `Signed (${read.trust}). Read from a file, so nothing here was compared with the chain: commit does that.` : `${read.reason}: commit will refuse this listing.`));
  } else {
    await ctx.ensureChain();
    listing = await inspectListing(ctx, listingId);
    if (!listing.spec) throw fail(listing.refusal, `Listing ${listingId}.`);
    local.push(gate('listingSigned', listing.refusal ? 'fail' : 'pass', listing.refusal ? `${listing.refusal}: commit will refuse this listing.` : `Signed (${listing.trust}), and what the chain holds is what it says.`));
    const read = await readPriorFindings(ctx, listingId);
    priors = read.findings;
    priorFindings = { read: read.findings.length, unread: read.unread, total: read.total };
  }
  // No run on a listing a commit would refuse: its image is one nobody attested, and this is the hunter's machine.
  if (local[0].status === 'fail') return { forecast: buildForecast({ local, answer: null, spec: listing.spec, pocPatch: Buffer.alloc(0), lint: [], priorFindings, notes: [] }), pack: null, run: null };
  // A listing that names stake.documents (node P20) is sent with its spec as signed, as the External Adapter sends it:
  // the runner reads the documents from the listed commit, and the forecast shows the tier it built (forecast.js).
  const { spec } = listing;
  if (!/@sha256:[0-9a-f]{64}$/.test(String(spec.env?.image ?? ''))) throw fail('LISTING_ARCHIVE_INVALID', 'Its image is not named by digest.');
  const files = runnerFilesOf(listing.listingBytes, spec);

  const inputs = readClaimInputs(claimDir);
  // Advice only (owner, 2026-11-10, Q73 #2): no gate reads the section, so it changes no forecast.
  const reportWarnings = requirementWarnings(inputs.report);
  const parsed = parseFinding(inputs.finding);
  const verdict = parsed.problem ? null : codeReview.validateFinding(parsed.value, spec);
  const schema = parsed.problem ? null : codeReview.validateFinding(parsed.value);
  const codes = (issues) => issues.map((i) => `${i.code} at ${i.path}: ${i.detail}`).join('; ');
  local.push(gate('finding', schema?.ok ? 'pass' : 'fail', schema?.ok ? 'finding.json validates.' : (parsed.problem ?? codes(schema.issues))));
  const inScope = verdict?.ok ?? false;
  if (schema?.ok) local.push(gate('inScope', inScope ? 'pass' : 'fail', inScope ? 'Every affected path is in the stake\'s scope.' : codes(verdict.issues)));
  const notes = [...fileNotes, ...(verdict?.warnings ?? []).map((w) => `${w.code}: ${w.detail}`)];

  const pocPatch = inputs.pocPatch ?? Buffer.alloc(0);
  const lint = schema?.ok ? lintObservable({ finding: parsed.value, pocPatch, baseline: files.baseline }) : [];
  const limit = maxPatchBytes(spec);
  const stop = (extra = []) => ({ forecast: buildForecast({ local: [...local, ...extra], answer: null, spec, pocPatch, lint, priorFindings, notes, reportWarnings }), pack: null, run: null });
  if (!schema?.ok || !inScope) return stop();
  const badReport = reportProblem(inputs.report);
  if (badReport) return stop([gate('report', 'fail', badReport)]);
  // The EA's own rules: a patch that is none, or past the limit, settles INVALID and never reaches a runner.
  const badPoc = pocProblem(inputs.pocPatch, spec);
  if (badPoc) return stop([gate('applies', 'fail', badPoc)]);

  const fixOver = inputs.fixPatch !== null && inputs.fixPatch.length > limit;
  if (fixOver) notes.push(`fix.patch is over maxPatchBytes (${limit}): arbiters ignore it, so it was not sent.`);
  const fixPatch = !fixOver && inputs.fixPatch?.length > 0 ? inputs.fixPatch : null;
  const report = inputs.report.toString('utf8');
  const reportMax = codeReview.getCodeClass(CODE_CLASS).envelope.contextPackTokens * BYTES_PER_PACK_TOKEN;
  const bcid = rawCid(buildClaimArchive({ finding: inputs.finding, report: inputs.report, pocPatch, fixPatch: inputs.fixPatch }));
  if (!isCidShaped(listing.listingCid)) throw fail('LISTING_ARCHIVE_INVALID');
  const request = {
    listingCid: listing.listingCid,
    bcid,
    spec,
    attestation: files.attestation,
    pocPatch: pocPatch.toString('base64'),
    fixPatch: fixPatch ? fixPatch.toString('base64') : null,
    baseline: files.baseline,
    finding: parsed.value,
    report: cutText(report, reportMax),
    knownIssues: files.knownIssues,
    priorFindings: priors,
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadline: deadlineMs,
    codeClass: CODE_CLASS,
  };
  const answer = await callRunner(ctx, request);
  const forecast = buildForecast({ local, answer, spec, pocPatch, lint, priorFindings, notes, reportWarnings });
  return { forecast, pack: answer.body?.contextPack ?? null, run: { runId: answer.body?.runId ?? null } };
}
