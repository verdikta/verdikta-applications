// The fact "staker controls the repository: yes / no" (node P8, design §4.1, §8.8, OWNER_QUEUE Q33):
// the rules a "yes" has to pass, with no chain or git in them.
//
// A listing is free to name any repository (third-party stakes stay allowed, design §14), so the
// record states whether its staker has shown control. A repository listing shows it with a file at
// the listed commit naming the maker's address, on a commit of the repository's own branches or
// tags. A contract listing shows it with a signature from the deployment's deployer or current
// owner; a repository file alone does not count for a contract, and the fact there is about the
// deployment, not the repository. Everything else is "no": no proof, a failed check, a host that
// cannot be read, a URL the site does not read.
//
// Proof formats: docs/control-proof.md.
import path from 'node:path';
import { getAddress } from 'ethers';

import { assertWording } from '../wording.js';

export const CONTROL_FILE = '.verdikta/stake-control.json';
export const CONTROL_MESSAGE_VERSION = 1;
export const CONTROL_MESSAGE_TITLE = 'Verdikta stake attestation: control of a deployment';
const CONTROL_MESSAGE_STATEMENT = 'The signer controls the deployment below and names the maker as its staker. This is not a transaction: it costs nothing and moves no funds.';

const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const CHAIN_ID = /^[1-9][0-9]{0,19}$/;
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_URL = 256;
const MAX_SEGMENTS = 8;

/**
 * One spelling per address, for every comparison: EIP-55. Only a checksummed or an all-lowercase
 * 0x address is one: a mixed case whose checksum fails, every letter in uppercase, no prefix, ICAP
 * or the zero address names nothing.
 * @returns {string|null}
 */
export function canonicalAddress(value) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) return null;
  const checksummed = getAddress(value.toLowerCase());
  if (checksummed === ZERO) return null;
  return value === checksummed || value === value.toLowerCase() ? checksummed : null;
}

/**
 * What a proof file says: { "version": 1, "maker": "<address>" } and nothing else.
 * @param {string|null} text
 * @returns {{ maker: string|null, problem: null|'NOT_JSON'|'FORMAT'|'ADDRESS_FORM' }}
 */
export function parseControlFile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { maker: null, problem: 'NOT_JSON' };
  }
  if (typeof text !== 'string') return { maker: null, problem: 'NOT_JSON' };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { maker: null, problem: 'FORMAT' };
  const keys = Object.keys(doc).sort();
  if (keys.length !== 2 || keys[0] !== 'maker' || keys[1] !== 'version' || doc.version !== 1) return { maker: null, problem: 'FORMAT' };
  const maker = canonicalAddress(doc.maker);
  return maker ? { maker, problem: null } : { maker: null, problem: 'ADDRESS_FORM' };
}

function urlParts(url) {
  if (typeof url !== 'string' || url.length > MAX_URL || !url.startsWith('https://')) return null;
  const rest = url.slice('https://'.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const host = rest.slice(0, slash);
  const segments = rest.slice(slash + 1).split('/');
  if (!HOST_NAME.test(host) || segments.length < 2 || segments.length > MAX_SEGMENTS) return null;
  if (!segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return null;
  return { host, segments };
}

/**
 * Whether the site reads a repository URL at all: exactly https://<host>/<owner>/<name>, in plain
 * ASCII, on a host of the list. The URL comes from the chain, so anyone chooses it: no credentials,
 * port, query, escape or dot segment that could make it read as one repository and fetch another,
 * and no host the operator did not name (nothing on the operator's network is reached this way).
 * @returns {{ ok: true, host: string } | { ok: false, reason: 'REPO_URL_FORM'|'REPO_HOST_NOT_CHECKED' }}
 */
export function repoUrlCheck(url, hosts) {
  const parts = urlParts(url);
  if (!parts) return { ok: false, reason: 'REPO_URL_FORM' };
  if (!hosts.includes(parts.host)) return { ok: false, reason: 'REPO_HOST_NOT_CHECKED' };
  return { ok: true, host: parts.host };
}

/** Where a checked URL's repository sits in a mirror folder (development only), or null. */
export function mirrorPath(dir, url) {
  const parts = urlParts(url);
  if (!parts) return null;
  const segments = [...parts.segments];
  segments[segments.length - 1] = `${segments.at(-1).replace(/\.git$/, '')}.git`;
  return path.join(dir, parts.host, ...segments);
}

/**
 * The text a contract listing's deployer or owner signs (EIP-191 personal_sign; EIP-1271's hash is
 * this message's EIP-191 hash). It binds the maker, the artifact hash (which covers the repository,
 * the commit, the chain and the contract), the chain and contract again in the reader's sight, and
 * the stake deployment, so a signature counts for this maker on this artifact on this site only.
 *
 * ASCII, one field per line, joined with "\n" and no final newline; docs/control-proof.md has it.
 * @throws {TypeError} a field outside its format, so no value can add a line of its own
 */
export function controlMessage({ maker, artifactHash, chainId, address, stakeChainId, stakeContract }) {
  const fields = { maker, address, stakeContract };
  for (const [name, value] of Object.entries(fields)) {
    if (!canonicalAddress(value)) throw new TypeError(`${name} is not a 20-byte 0x address`);
  }
  if (typeof artifactHash !== 'string' || !HASH.test(artifactHash)) throw new TypeError('the artifact hash is 0x and 64 hex digits');
  for (const [name, value] of Object.entries({ chainId, stakeChainId })) {
    if (!CHAIN_ID.test(String(value))) throw new TypeError(`${name} is not a chain id`);
  }
  return [
    CONTROL_MESSAGE_TITLE,
    CONTROL_MESSAGE_STATEMENT,
    '',
    `Version: ${CONTROL_MESSAGE_VERSION}`,
    `Maker: ${canonicalAddress(maker)}`,
    `Artifact Hash: ${artifactHash.toLowerCase()}`,
    `Chain Id: ${chainId}`,
    `Contract: ${canonicalAddress(address)}`,
    `Stake Chain Id: ${stakeChainId}`,
    `Stake Contract: ${canonicalAddress(stakeContract)}`,
  ].join('\n');
}

/** Why a fact is "no", in words anyone can check against the record. Facts only. */
export const CONTROL_REASONS = Object.freeze(Object.fromEntries(Object.entries({
  NOT_CHECKED_YET: 'The site has not finished checking this listing yet.',
  REPO_URL_FORM: 'The site reads repository URLs of the form https://host/owner/name only, and this one has another form.',
  REPO_HOST_NOT_CHECKED: 'The site does not read repositories on this host.',
  REPO_UNAVAILABLE: 'The git host could not be read at the last check. The site tries again.',
  REPO_TOO_LARGE: 'Reading the repository took more than the site\'s limit.',
  COMMIT_NOT_ON_OWN_REFS: 'The listed commit is not on any of the repository\'s own branches or tags. A host can serve a fork\'s commit through the parent\'s URL.',
  NO_PROOF_FILE: `The listed commit has no file at ${CONTROL_FILE}.`,
  PROOF_FILE_INVALID: `The file at ${CONTROL_FILE} in the listed commit is not in the documented format.`,
  PROOF_NAMES_ANOTHER_ADDRESS: `The file at ${CONTROL_FILE} in the listed commit names another address than this listing's maker.`,
  NO_SIGNATURE: 'No signature from the deployment\'s deployer or current owner has been sent.',
  SIGNATURE_INVALID: 'The signature is not the signer\'s signature of this listing\'s message.',
  SIGNER_NOT_CONTROLLER: 'The signer is not the deployment\'s current owner, and no creation transaction shows it as the deployer.',
  NO_CONTRACT_AT_ADDRESS: 'The listing\'s chain holds no contract at this address.',
  CHAIN_NOT_CHECKED: 'The site does not read the listing\'s chain.',
  CHAIN_UNAVAILABLE: 'The listing\'s chain could not be read at the last check. The site tries again.',
}).map(([code, text]) => [code, assertWording(text)])));

/** The fact in words, as the record and the badge state it. */
export const statementOf = (subject, yes) => assertWording(`staker controls the ${subject}: ${yes ? 'yes' : 'no'}`);

const seconds = (ms) => (ms === null || ms === undefined ? null : Math.floor(ms / 1000));
const line = (reason) => (reason ? CONTROL_REASONS[reason] ?? null : null);

function repositoryView({ entry, repo, commit, maker, hosts }) {
  const url = repoUrlCheck(repo, hosts);
  const answered = url.ok && entry && !entry.error;
  let reason = null;
  if (!url.ok) reason = url.reason;
  else if (!entry) reason = 'NOT_CHECKED_YET';
  else if (entry.error) reason = entry.error;
  else if (!entry.reachable) reason = 'COMMIT_NOT_ON_OWN_REFS';
  else if (!entry.file) reason = 'NO_PROOF_FILE';
  else if (!entry.file.named) reason = 'PROOF_FILE_INVALID';
  else if (entry.file.named !== maker) reason = 'PROOF_NAMES_ANOTHER_ADDRESS';
  return {
    controls: reason === null ? 'yes' : 'no',
    reason,
    detail: line(reason),
    repo,
    commit,
    path: CONTROL_FILE,
    readable: url.ok,
    commitOnOwnRefs: answered ? entry.reachable : null,
    ref: answered ? entry.ref : null,
    blob: answered ? entry.file?.blob ?? null : null,
    named: answered ? entry.file?.named ?? null : null,
    checkedAt: url.ok ? seconds(entry?.checkedAt) : null,
    nextCheckAt: url.ok ? seconds(entry?.nextAt) : null,
  };
}

function deploymentView({ entry, message, chainId, address }) {
  const reason = !entry ? 'NO_SIGNATURE' : entry.ok ? null : entry.reason;
  return {
    controls: reason === null ? 'yes' : 'no',
    reason,
    detail: line(reason),
    chainId,
    address,
    message,
    signer: entry?.signer ?? null,
    signature: entry?.signature ?? null,
    role: entry?.ok ? entry.role : null,
    contractSigner: entry?.ok ? entry.contractSigner : null,
    creationTx: entry?.creationTx ?? null,
    block: entry?.ok ? entry.block : null,
    checkedAt: seconds(entry?.checkedAt),
    nextCheckAt: seconds(entry?.nextAt),
  };
}

/**
 * One listing's fact, from the stored answers. The maker is the listing's on-chain maker, and the
 * answers are keyed by what they are about (the repository at the commit; the artifact hash and the
 * maker), so a listing can never read another's "yes", also after a reorg moved a listing id.
 * @param {object} o
 * @param {{ repositories: object, deployments: object }} o.control - the store's answers
 * @param {string} o.artifactHash
 * @param {string} o.maker
 * @param {{ kind: string, repo: string, baseCommit: string, chainId: string, address: string }|null} o.artifact - from its Listed event
 * @param {string[]} o.hosts - the git hosts the site reads
 * @param {{ chainId: number, address: string }} o.stake - the deployment this site indexes
 */
export function controlFact({ control, artifactHash, maker, artifact, hosts, stake }) {
  if (!artifact) {
    return { maker, subject: 'repository', controls: 'no', statement: statementOf('repository', false), reason: 'NOT_CHECKED_YET', detail: line('NOT_CHECKED_YET'), checkedAt: null, nextCheckAt: null, repository: null, deployment: null };
  }
  const repository = repositoryView({ entry: control.repositories[repoKey(artifact)] ?? null, repo: artifact.repo, commit: artifact.baseCommit, maker, hosts });
  const isContract = artifact.kind === 'Contract';
  const deployment = isContract
    ? deploymentView({
      entry: control.deployments[deploymentKey(artifactHash, maker)] ?? null,
      message: controlMessage({ maker, artifactHash, chainId: artifact.chainId, address: artifact.address, stakeChainId: stake.chainId, stakeContract: stake.address }),
      chainId: artifact.chainId,
      address: artifact.address,
    })
    : null;
  const main = isContract ? deployment : repository;
  const subject = isContract ? 'deployment' : 'repository';
  return {
    maker,
    subject,
    controls: main.controls,
    statement: statementOf(subject, main.controls === 'yes'),
    reason: main.reason,
    detail: main.detail,
    checkedAt: main.checkedAt,
    nextCheckAt: main.nextCheckAt,
    repository,
    deployment,
  };
}

/** Where an answer is stored: by what it is about, never by a listing id. */
export const repoKey = (artifact) => `${artifact.repo}@${artifact.baseCommit}`;
export const deploymentKey = (artifactHash, maker) => `${artifactHash.toLowerCase()}:${maker}`;
