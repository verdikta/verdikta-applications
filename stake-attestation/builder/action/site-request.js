#!/usr/bin/env node
// A listing request from the site, in Verdikta's caller (node P15; docs/builder-kms-signing.md). The request is a
// stranger's, and a token holder could send anything as one, so two jobs that run nothing of the maker's check it:
//
//   unpack  the source job: the request is the maker's wallet's, and leaves as files at fixed names
//   check   the sign job, on the build's output folder: again the maker's wallet's, and the built files keep every
//           term it signed. An image anywhere but the repository the job names is refused
//
// So a stolen token gets no signature for a wallet it doesn't hold, and a build job that lied changes no term. Both
// read SITE_REQUEST, SITE_AUTH and MAKER from the environment, never from an argument.
//
//   node action/site-request.js unpack --out <dir>      (writes spec, known-issues, deployment-proof to GITHUB_OUTPUT)
//   node action/site-request.js check --dir <dir> --publish-as <repository>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAddress, verifyMessage } from 'ethers';
import { SiteRequestError, serializeKnownIssues, specChanges, verifySiteRequest } from '@verdikta/stake-attestation-shared/site-request';

import { codeReview } from '../src/common.js';
import { neutralize } from '../src/logSafe.js';

const PLAIN_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
const fail = (code, detail) => { throw new SiteRequestError(code, detail); };

/**
 * @param {{ request: string, auth: string, maker: string, out: string }} o
 * @returns {{ spec: string, knownIssues: string, deploymentProof: string }} file names in `out`, '' for none
 * @throws {SiteRequestError}
 */
export function unpackSiteRequest({ request, auth, maker, out }) {
  const { body, auth: a } = verifySiteRequest({ request, auth, maker }, { verifyMessage, getAddress });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'draft.json'), `${JSON.stringify(body.spec, null, 2)}\n`);
  const names = { spec: 'draft.json', knownIssues: '', deploymentProof: '' };
  if (body.knownIssues !== undefined && body.knownIssues !== null) {
    names.knownIssues = 'known_issues.json';
    fs.writeFileSync(path.join(out, names.knownIssues), serializeKnownIssues(body.knownIssues));
  }
  if (body.deploymentProof) {
    const p = body.deploymentProof;
    names.deploymentProof = 'control-proof.json';
    // as the server hands it to the builder: its stake deployment is bound by the signature, so a wrong one fails there
    fs.writeFileSync(path.join(out, names.deploymentProof), `${JSON.stringify({ signer: getAddress(String(p.signer).toLowerCase()), signature: p.signature, creationTx: p.creationTx ?? null, stakeChainId: a.stakeChainId, stakeContract: a.stakeContract })}\n`);
  }
  return names;
}

/**
 * @param {{ request: string, auth: string, maker: string, dir: string, publishAs: string }} o
 * @returns {{ maker: string }}
 * @throws {SiteRequestError}
 */
export function checkSignedFiles({ request, auth, maker, dir, publishAs }) {
  const { body, maker: canonical } = verifySiteRequest({ request, auth, maker }, { verifyMessage, getAddress });
  let built;
  try {
    built = JSON.parse(fs.readFileSync(path.join(dir, 'code_review.json'), 'utf8'));
  } catch {
    fail('SITE_REQUEST_TERMS_CHANGED', 'the build left no readable code_review.json');
  }
  const changed = specChanges(body.spec, built, { attestationFile: codeReview.ATTESTATION_FILE, baselineFile: codeReview.BASELINE_FILE });
  if (changed.length) fail('SITE_REQUEST_TERMS_CHANGED', `the built code_review.json changed what the maker's wallet signed at ${changed.join(', ')}`);
  const name = built.stake?.knownIssues;
  if (name) {
    if (!PLAIN_NAME.test(String(name))) fail('SITE_REQUEST_TERMS_CHANGED', 'code_review.json names its known issues by something other than a plain name');
    let bytes = null;
    try {
      bytes = fs.readFileSync(path.join(dir, name));
    } catch { /* below */ }
    if (!bytes || !bytes.equals(serializeKnownIssues(body.knownIssues))) fail('SITE_REQUEST_TERMS_CHANGED', 'the built known issues are not the ones the maker\'s wallet signed');
  }
  if (typeof built.env?.image !== 'string' || !built.env.image.startsWith(`${publishAs}@`)) fail('SITE_REQUEST_IMAGE_ELSEWHERE', `the listing's image is not in ${publishAs}`);
  return { maker: canonical };
}

function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) opts[String(rest[i]).replace(/^--/, '')] = rest[i + 1];
  const sent = { request: env.SITE_REQUEST, auth: env.SITE_AUTH, maker: env.MAKER };
  try {
    if (command === 'unpack' && opts.out && env.GITHUB_OUTPUT) {
      const n = unpackSiteRequest({ ...sent, out: opts.out });
      fs.appendFileSync(env.GITHUB_OUTPUT, `spec=${n.spec}\nknown-issues=${n.knownIssues}\ndeployment-proof=${n.deploymentProof}\n`);
      process.stdout.write('the maker\'s wallet signed this request\n');
    } else if (command === 'check' && opts.dir && opts['publish-as']) {
      checkSignedFiles({ ...sent, dir: opts.dir, publishAs: opts['publish-as'] });
      process.stdout.write('the maker\'s wallet signed this request, and the built files keep its terms\n');
    } else {
      process.stderr.write('usage: node action/site-request.js unpack --out <dir>\n       node action/site-request.js check --dir <dir> --publish-as <repository>\n');
      return 64;
    }
    return 0;
  } catch (err) {
    if (!(err instanceof SiteRequestError)) throw err;
    process.stderr.write(neutralize(`site-request: ${err.code}: ${err.detail}\n`));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
