// The rules of the project's proof (owner decision Q34; docs/control-proof.md), in one place: the
// builder refuses by them, the server's listing flow refuses by them, the site counts by them and
// the hunter tool can check by them. A repository listing needs a file at the listed commit naming
// the listing's maker, on one of the repository's own branches or tags; a contract listing also
// needs a signature from the deployment's deployer or current owner.
//
// This package has no dependency, so what needs ethers takes it as an argument (createControlProof):
// each package passes its own pinned copy.

export const CONTROL_FILE = '.verdikta/stake-control.json';
export const CONTROL_MESSAGE_VERSION = 1;
export const CONTROL_MESSAGE_TITLE = 'Verdikta stake attestation: control of a deployment';
const CONTROL_MESSAGE_STATEMENT = 'The signer controls the deployment below and names the maker as its staker. This is not a transaction: it costs nothing and moves no funds.';

export const DEFAULT_GIT_HOSTS = Object.freeze(['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org']);

const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const CHAIN_ID = /^[1-9][0-9]{0,19}$/;
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_URL = 256;
const MAX_SEGMENTS = 8;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){1,4096}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;

/** Each refusal of a listing for its proof, by the code the builder and the server both use. Facts only. */
export const PROOF_REFUSALS = Object.freeze({
  MAKER_REQUIRED: 'A listing names its maker: the wallet that will send list(). The project names that address in its repository.',
  MAKER_INVALID: 'The maker is the 0x address of the wallet that will send list().',
  MAKER_SIGNATURE_REQUIRED: 'The maker signs the listing request with its wallet, so a listing cannot name another wallet as its maker.',
  MAKER_SIGNATURE_INVALID: 'The listing request is not signed by the wallet it names as its maker.',
  REPO_URL_FORM: 'The site reads repository URLs of the form https://host/owner/name only, and this one has another form.',
  REPO_HOST_NOT_CHECKED: 'The site does not read repositories on this host.',
  REPO_TOO_LARGE: 'Reading the repository took more than the limit.',
  COMMIT_NOT_ON_OWN_REFS: 'The listed commit is not on any of the repository\'s own branches or tags. A host can serve a fork\'s commit through the parent\'s URL.',
  NO_PROOF_FILE: `The listed commit has no file at ${CONTROL_FILE}.`,
  PROOF_FILE_INVALID: `The file at ${CONTROL_FILE} in the listed commit is not in the documented format.`,
  PROOF_NAMES_ANOTHER_ADDRESS: `The file at ${CONTROL_FILE} in the listed commit names another address than this listing's maker.`,
  NO_SIGNATURE: 'No signature from the deployment\'s deployer or current owner has been sent.',
  SIGNATURE_INVALID: 'The signature is not the signer\'s signature of this listing\'s message.',
  SIGNER_NOT_CONTROLLER: 'The signer is not the deployment\'s current owner, and no creation transaction shows it as the deployer.',
  NO_CONTRACT_AT_ADDRESS: 'The listing\'s chain holds no contract at this address.',
  CHAIN_NOT_CHECKED: 'The site does not read the listing\'s chain.',
});

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

/** A repository URL's host and path segments, in the one form the site reads, or null. */
export const repoUrlParts = urlParts;

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

/**
 * Why a repository answer is no proof for `maker`, or null: `answer` is the git check's
 * ({ reachable, file }), the file read with parseControlFile into file.named.
 * @returns {null|'COMMIT_NOT_ON_OWN_REFS'|'NO_PROOF_FILE'|'PROOF_FILE_INVALID'|'PROOF_NAMES_ANOTHER_ADDRESS'}
 */
export function repositoryProofReason(answer, maker) {
  if (!answer.reachable) return 'COMMIT_NOT_ON_OWN_REFS';
  if (!answer.file) return 'NO_PROOF_FILE';
  if (!answer.file.named) return 'PROOF_FILE_INVALID';
  return answer.file.named === maker ? null : 'PROOF_NAMES_ANOTHER_ADDRESS';
}

/** A chain read that may answer nothing, in a form a fact can state. */
export class ChainReadError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'ChainReadError';
    this.code = code;
  }
}

/** A deployment proof's fields as sent, or what is wrong with them. */
export function proofFieldProblem(o, canonicalAddress) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { code: 'BAD_SIGNER', detail: 'the proof is an object { signer, signature, creationTx? }' };
  if (!canonicalAddress(o.signer)) return { code: 'BAD_SIGNER', detail: 'signer is an EIP-55 or all-lowercase 0x address' };
  if (typeof o.signature !== 'string' || !SIGNATURE.test(o.signature)) return { code: 'BAD_SIGNATURE', detail: 'signature is 0x hex, at most 4,096 bytes' };
  const tx = o.creationTx ?? null;
  if (tx !== null && (typeof tx !== 'string' || !TX_HASH.test(tx))) return { code: 'BAD_CREATION_TX', detail: 'creationTx is the deployment\'s transaction hash, 0x and 64 lowercase hex digits' };
  return null;
}

/**
 * The rules that need ethers.
 * @param {{ AbiCoder: object, Interface: Function, getAddress: Function, hashMessage: Function, keccak256: Function, verifyMessage: Function }} ethers
 */
export function createControlProof({ AbiCoder, Interface, getAddress, hashMessage, keccak256, verifyMessage }) {
  /**
   * One spelling per address, for every comparison: EIP-55. Only a checksummed or an all-lowercase
   * 0x address is one: a mixed case whose checksum fails, every letter in uppercase, no prefix, ICAP
   * or the zero address names nothing.
   * @returns {string|null}
   */
  function canonicalAddress(value) {
    if (typeof value !== 'string' || !ADDRESS.test(value)) return null;
    const checksummed = getAddress(value.toLowerCase());
    if (checksummed === ZERO) return null;
    return value === checksummed || value === value.toLowerCase() ? checksummed : null;
  }

  /**
   * What a proof file says: { "version": 1, "maker": "<address>" } and nothing else: one address.
   * @param {string|null} text
   * @returns {{ maker: string|null, problem: null|'NOT_JSON'|'FORMAT'|'ADDRESS_FORM' }}
   */
  function parseControlFile(text) {
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

  /** The git check's file entry with what it names: { blob, named, problem }; null for no file. */
  function readAnswerFile(file) {
    if (!file) return null;
    const parsed = file.problem || file.text === null ? { maker: null, problem: file.problem ?? 'NOT_JSON' } : parseControlFile(file.text);
    return { blob: file.blob, named: parsed.maker, problem: parsed.problem };
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
  function controlMessage({ maker, artifactHash, chainId, address, stakeChainId, stakeContract }) {
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

  const coder = AbiCoder.defaultAbiCoder();
  /** StakeAttestation.artifactHashOf for a deployed contract: the record key the message names. */
  const contractArtifactHash = ({ repo, baseCommit, chainId, address }) => keccak256(coder.encode(
    ['uint8', 'string', 'string', 'uint64', 'address'],
    [1, repo, baseCommit, String(chainId), getAddress(address.toLowerCase())],
  ));

  const EIP1271_MAGIC = '0x1626ba7e';
  const MAGIC_WORD = `${EIP1271_MAGIC}${'0'.repeat(56)}`;
  const OWNER_CALL = new Interface(['function owner() view returns (address)']).encodeFunctionData('owner');
  const EIP1271 = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
  const ADDRESS_WORD = /^0x0{24}([0-9a-fA-F]{40})$/;

  /** The node's answer to a call, or null when the call reverted (not when the node cannot be read). */
  async function callOrNull(provider, to, data, blockTag) {
    try {
      return await provider.call({ to, data, blockTag });
    } catch (err) {
      if (err?.code === 'CALL_EXCEPTION') return null;
      throw err;
    }
  }

  /** The address owner() answers, or null: it reverts, answers no address, or answers zero. */
  async function ownerOf(provider, address, blockTag) {
    const word = await callOrNull(provider, address, OWNER_CALL, blockTag);
    const m = word ? ADDRESS_WORD.exec(word) : null;
    if (!m) return null;
    const owner = getAddress(`0x${m[1].toLowerCase()}`);
    return owner === ZERO ? null : owner;
  }

  /**
   * Whether `signer` signed `message`: { valid, contract }. ECDSA first: a signature that recovers to the signer is its
   * own, contract false, and nothing is read, whatever code its account holds (an EIP-7702 delegation designator, as
   * the testnet maker's has). Only one that doesn't recover reads the signer's code and, if there is any, asks its
   * EIP-1271 isValidSignature.
   */
  async function signatureCheck(provider, { message, signer, signature, blockTag }) {
    let recovered = null;
    try {
      recovered = verifyMessage(message, signature);
    } catch { /* not an ECDSA signature: a contract may still answer for it */ }
    if (recovered === signer) return { valid: true, contract: false };
    const code = await provider.getCode(signer, blockTag);
    if (!code || code === '0x') return { valid: false, contract: false };
    const data = EIP1271.encodeFunctionData('isValidSignature', [hashMessage(message), signature]);
    const answer = await callOrNull(provider, signer, data, blockTag);
    return { valid: answer === MAGIC_WORD, contract: true };
  }

  /**
   * A contract listing's proof, checked on the listing's chain: a signature of the listing's message
   * from the deployment's current owner (owner(), EIP-173's read) or its deployer (the transaction
   * that created it, given by its hash, so a reader can look it up: tx.from is the signer and its
   * receipt's contractAddress is the deployment; a deployment made through a factory has no such
   * transaction and is proved by its owner). The signer's signature is recovered first, and counts
   * whatever code its account holds; one that doesn't recover counts only if the signer has code and
   * its EIP-1271 isValidSignature answers for it. Every read is of one block, which the record states.
   * @param {{ send: Function, getBlockNumber: Function, getCode: Function, call: Function, getTransaction: Function, getTransactionReceipt: Function }} provider -
   *   the listing's chain
   * @param {object} o
   * @param {string} o.message - controlMessage's text for the listing
   * @param {number|bigint|string} o.chainId - the listing's chain
   * @param {string} o.address - the deployment
   * @param {string} o.signer - EIP-55
   * @param {string} o.signature
   * @param {string|null} o.creationTx
   * @returns {Promise<{ ok: true, role: 'owner'|'deployer', contractSigner: boolean, block: number } | { ok: false, reason: string }>}
   * @throws {ChainReadError} CHAIN_NOT_CHECKED (the provider is on another chain); anything else the
   *   provider throws means the chain could not be read
   */
  async function checkDeploymentProof(provider, { message, chainId, address, signer, signature, creationTx }) {
    const answered = BigInt(await provider.send('eth_chainId', []));
    if (answered !== BigInt(chainId)) throw new ChainReadError('CHAIN_NOT_CHECKED', `the provider is on chain ${answered}, not ${chainId}`);
    const block = await provider.getBlockNumber();
    const code = await provider.getCode(address, block);
    if (!code || code === '0x') return { ok: false, reason: 'NO_CONTRACT_AT_ADDRESS' };

    const { valid, contract } = await signatureCheck(provider, { message, signer, signature, blockTag: block });
    if (!valid) return { ok: false, reason: 'SIGNATURE_INVALID' };

    if ((await ownerOf(provider, address, block)) === signer) return { ok: true, role: 'owner', contractSigner: contract, block };
    if (creationTx) {
      // one read at a time, so that when this check settles no read of it is still in flight
      const receipt = await provider.getTransactionReceipt(creationTx);
      if (receipt && receipt.status === 1 && receipt.blockNumber <= block && receipt.contractAddress === address) {
        const tx = await provider.getTransaction(creationTx);
        if (tx && tx.from === signer) return { ok: true, role: 'deployer', contractSigner: contract, block };
      }
    }
    return { ok: false, reason: 'SIGNER_NOT_CONTROLLER' };
  }

  return { canonicalAddress, parseControlFile, readAnswerFile, controlMessage, contractArtifactHash, signatureCheck, checkDeploymentProof, EIP1271_MAGIC };
}
