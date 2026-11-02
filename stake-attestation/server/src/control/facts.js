// The project's proof as a fact on the record (node P8, design §4.1, §8.8; owner decisions Q33, Q34):
// the rules a "yes" has to pass, with no chain or git in them. The rules themselves are shared with
// the builder (shared/src/controlProof.js).
//
// Every listing needs the proof, or the builder refuses it and the site does not count it. A
// repository listing has it when a file at the listed commit names the maker's address, on a commit of
// the repository's own branches or tags: the staker is named by the repository, which a sponsor's
// wallet can be, so the words say "named by" and not "controls". A contract listing also needs a
// signature from the deployment's deployer or current owner: the staker controls the deployment.
// Everything else is "no": no proof, a failed check, a host that cannot be read, a URL the site does
// not read.
//
// Proof formats: docs/control-proof.md.
import path from 'node:path';
import { AbiCoder, Interface, getAddress, hashMessage, keccak256, verifyMessage } from 'ethers';
import {
  CONTROL_FILE,
  CONTROL_MESSAGE_TITLE,
  CONTROL_MESSAGE_VERSION,
  PROOF_REFUSALS,
  createControlProof,
  repoUrlCheck,
  repoUrlParts,
  repositoryProofReason,
} from '@verdikta/stake-attestation-shared/control-proof';

import { assertWording } from '../wording.js';

export { CONTROL_FILE, CONTROL_MESSAGE_TITLE, CONTROL_MESSAGE_VERSION, repoUrlCheck };

export const controlProof = createControlProof({ AbiCoder, Interface, getAddress, hashMessage, keccak256, verifyMessage });
export const { canonicalAddress, parseControlFile, readAnswerFile, controlMessage } = controlProof;

/** Where a checked URL's repository sits in a mirror folder (development only), or null. */
export function mirrorPath(dir, url) {
  const parts = repoUrlParts(url);
  if (!parts) return null;
  const segments = [...parts.segments];
  segments[segments.length - 1] = `${segments.at(-1).replace(/\.git$/, '')}.git`;
  return path.join(dir, parts.host, ...segments);
}

/** Why a fact is "no", in words anyone can check against the record. Facts only. */
export const CONTROL_REASONS = Object.freeze(Object.fromEntries(Object.entries({
  ...PROOF_REFUSALS,
  NOT_CHECKED_YET: 'The site has not finished checking this listing yet.',
  REPO_UNAVAILABLE: 'The git host could not be read at the last check. The site tries again.',
  CHAIN_UNAVAILABLE: 'The listing\'s chain could not be read at the last check. The site tries again.',
  // a listing's archive, for the reason it does not count (counting.js)
  NOT_SIGNED_BY_BUILDER: 'The listing archive carries no attestation that verifies under the builder keys this site accepts, so the builder did not sign this listing.',
  ARCHIVE_UNAVAILABLE: 'The listing archive has not been read yet. The site tries again.',
  ARCHIVE_INVALID: 'The listing\'s CID does not hold the archive the listing flow issues for its files: another panel, query, member or form.',
  ARCHIVE_TOO_LARGE: 'The listing\'s archive is larger than the site reads.',
  ARCHIVE_NOT_CID: 'The bytes the site was given for the listing\'s CID do not hash to it.',
  ARCHIVE_MISMATCH: 'What the chain holds for this listing is not what its signed archive says: another artifact, disclosure key or terms.',
}).map(([code, text]) => [code, assertWording(text)])));

/** The fact in words, as the record and the badge state it. */
export const statementOf = (subject, yes) => assertWording(subject === 'deployment'
  ? `staker controls the deployment: ${yes ? 'yes' : 'no'}`
  : `staker named by the repository: ${yes ? 'yes' : 'no'}`);

/** How long an answer stands through checks that get no answer: past it the record says so, whatever is on file. */
export const KEEP_ANSWER_MS = 7 * 86400_000;
const outlived = (entry, now) => Boolean(entry?.lastCheckFailed) && now - (entry.answeredAt ?? entry.checkedAt ?? 0) >= KEEP_ANSWER_MS;

const seconds = (ms) => (ms === null || ms === undefined ? null : Math.floor(ms / 1000));
const line = (reason) => (reason ? CONTROL_REASONS[reason] ?? null : null);

function repositoryView({ entry, repo, commit, maker, hosts, now }) {
  const url = repoUrlCheck(repo, hosts);
  const answered = url.ok && entry && !entry.error && !outlived(entry, now);
  let reason = null;
  if (!url.ok) reason = url.reason;
  else if (!entry) reason = 'NOT_CHECKED_YET';
  else if (entry.error) reason = entry.error;
  else if (outlived(entry, now)) reason = entry.lastCheckFailed;
  else reason = repositoryProofReason(entry, maker);
  return {
    named: reason === null ? 'yes' : 'no',
    reason,
    detail: line(reason),
    repo,
    commit,
    path: CONTROL_FILE,
    readable: url.ok,
    commitOnOwnRefs: answered ? entry.reachable : null,
    ref: answered ? entry.ref : null,
    blob: answered ? entry.file?.blob ?? null : null,
    fileNames: answered ? entry.file?.named ?? null : null,
    checkedAt: url.ok ? seconds(entry?.checkedAt) : null,
    nextCheckAt: url.ok ? seconds(entry?.nextAt) : null,
    lastCheckFailed: url.ok ? entry?.lastCheckFailed ?? null : null,
  };
}

function deploymentView({ entry, message, chainId, address, now }) {
  let reason = !entry ? 'NO_SIGNATURE' : entry.ok ? null : entry.reason;
  if (reason === null && outlived(entry, now)) reason = entry.lastCheckFailed;
  return {
    controls: reason === null ? 'yes' : 'no',
    reason,
    detail: line(reason),
    chainId,
    address,
    message,
    signer: entry?.signer ?? null,
    signature: entry?.signature ?? null,
    role: reason === null ? entry.role : null,
    contractSigner: reason === null ? entry.contractSigner : null,
    creationTx: entry?.creationTx ?? null,
    block: reason === null ? entry.block : null,
    checkedAt: seconds(entry?.checkedAt),
    nextCheckAt: seconds(entry?.nextAt),
    lastCheckFailed: entry?.lastCheckFailed ?? null,
  };
}

/**
 * One listing's fact, from the stored answers. The maker is the listing's on-chain maker, and the
 * answers are keyed by what they are about (the repository at the commit; the artifact hash and the
 * maker), so a listing can never read another's "yes", also after a reorg moved a listing id, and a
 * replay from another wallet reads a file that names someone else.
 * @param {object} o
 * @param {{ repositories: object, deployments: object }} o.control - the store's answers
 * @param {string} o.artifactHash
 * @param {string} o.maker
 * @param {{ kind: string, repo: string, baseCommit: string, chainId: string, address: string }|null} o.artifact - from its Listed event
 * @param {string[]} o.hosts - the git hosts the site reads
 * @param {{ chainId: number, address: string }} o.stake - the deployment this site indexes
 * @param {number} [o.now] - the site's clock, ms: an answer kept through failed checks has an age limit
 * @returns {object} { maker, subject, proof: 'yes'|'no', statement, reason, detail, ..., repository, deployment }
 */
export function controlFact({ control, artifactHash, maker, artifact, hosts, stake, now = Date.now() }) {
  if (!artifact) {
    return { maker, subject: 'repository', proof: 'no', statement: statementOf('repository', false), reason: 'NOT_CHECKED_YET', detail: line('NOT_CHECKED_YET'), checkedAt: null, nextCheckAt: null, repository: null, deployment: null };
  }
  const repository = repositoryView({ entry: control.repositories[repoKey(artifact)] ?? null, repo: artifact.repo, commit: artifact.baseCommit, maker, hosts, now });
  const isContract = artifact.kind === 'Contract';
  const deployment = isContract
    ? deploymentView({
      entry: control.deployments[deploymentKey(artifactHash, maker)] ?? null,
      message: controlMessage({ maker, artifactHash, chainId: artifact.chainId, address: artifact.address, stakeChainId: stake.chainId, stakeContract: stake.address }),
      chainId: artifact.chainId,
      address: artifact.address,
      now,
    })
    : null;
  const named = repository.named === 'yes';
  const controls = deployment?.controls === 'yes';
  const yes = named && (!isContract || controls);
  const failing = named ? deployment : repository;
  const main = yes || !failing ? (deployment ?? repository) : failing;
  const statement = isContract
    ? `${statementOf('repository', named)} · ${statementOf('deployment', controls)}`
    : statementOf('repository', named);
  return {
    maker,
    subject: isContract ? 'deployment' : 'repository',
    proof: yes ? 'yes' : 'no',
    statement,
    reason: yes ? null : main.reason,
    detail: yes ? null : main.detail,
    checkedAt: main.checkedAt,
    nextCheckAt: main.nextCheckAt,
    repository,
    deployment,
  };
}

/** Where an answer is stored: by what it is about, never by a listing id. */
export const repoKey = (artifact) => `${artifact.repo}@${artifact.baseCommit}`;
export const deploymentKey = (artifactHash, maker) => `${artifactHash.toLowerCase()}:${maker}`;
