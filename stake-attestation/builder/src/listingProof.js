// The project's proof, checked before anything of a listing is fetched for a build or signed (node
// P9, owner decision Q34): every listing needs a file at the listed commit naming the listing's
// maker, on one of the repository's own branches or tags, and a contract listing also a signature
// from the deployment's deployer or current owner. No allowlist and no exception: the rules are
// shared/src/controlProof.js, the ones the site counts by.
//
// The commit is read with controlCheck.js, which fetches only the repository's refs/heads and
// refs/tags, because a host serves a commit by id without asking what holds it: on GitHub a fork
// shares the parent's object store. A contract's signature is checked through the explorer the
// verified-source check already reads (its proxy module, in the Etherscan shape).
//
// A refusal is the maker's and stops the listing; a host or an explorer that cannot be read is a
// BuilderError, to retry, and never an acceptance.
import { AbiCoder, Interface, getAddress, hashMessage, keccak256, verifyMessage } from 'ethers';
import {
  CONTROL_FILE,
  ChainReadError,
  PROOF_REFUSALS,
  createControlProof,
  proofFieldProblem,
  repoUrlCheck,
  repositoryProofReason,
} from '@verdikta/stake-attestation-shared/control-proof';

import { checkRepositoryControl as checkDefault } from './controlCheck.js';
import { BuilderError, Refusal } from './errors.js';

const rules = createControlProof({ AbiCoder, Interface, getAddress, hashMessage, keccak256, verifyMessage });
const refuse = (code) => new Refusal(code, PROOF_REFUSALS[code]);

/** The message a contract listing's deployer or owner signs, for this spec, maker and stake deployment. */
export function deploymentMessage({ spec, maker, stake }) {
  const { chainId, address } = spec.artifact;
  const canonical = getAddress(address.toLowerCase());
  return rules.controlMessage({
    maker,
    artifactHash: rules.contractArtifactHash({ repo: spec.repo, baseCommit: spec.baseCommit, chainId, address: canonical }),
    chainId,
    address: canonical,
    stakeChainId: stake.chainId,
    stakeContract: stake.address,
  });
}

/**
 * The repository half, for the maker. Reads the host (or the configured mirror).
 * @returns {Promise<{ ref: string|null, blob: string }>}
 * @throws {Refusal|BuilderError}
 */
export async function checkRepositoryProof({ repo, baseCommit, maker, config, deps = {} }) {
  const url = repoUrlCheck(repo, config.control.gitHosts);
  if (!url.ok) throw refuse(url.reason);
  const check = deps.checkRepositoryControl ?? checkDefault;
  let answer;
  try {
    answer = await check({ repo, baseCommit, mirror: config.mirrorFor(repo), timeoutMs: config.control.timeoutMs, maxBytes: config.control.maxBytes });
  } catch (err) {
    if (err?.code === 'REPO_TOO_LARGE') throw refuse('REPO_TOO_LARGE');
    throw err;
  }
  const file = rules.readAnswerFile(answer.file);
  const reason = repositoryProofReason({ reachable: answer.reachable, file }, maker);
  if (reason) throw refuse(reason);
  return { ref: answer.ref, blob: file.blob };
}

/** A contract's signature, on its chain. @returns {Promise<object>} what the report records */
async function checkDeployment({ draft, maker, proof, chainFor }) {
  if (!proof) throw refuse('NO_SIGNATURE');
  if (proofFieldProblem(proof, rules.canonicalAddress)) throw refuse('SIGNATURE_INVALID');
  const stakeContract = rules.canonicalAddress(proof.stakeContract);
  if (!stakeContract || !/^[1-9][0-9]{0,15}$/.test(String(proof.stakeChainId))) throw refuse('SIGNATURE_INVALID');
  const stake = { chainId: Number(proof.stakeChainId), address: stakeContract };
  const signer = rules.canonicalAddress(proof.signer);
  const { chainId, address } = draft.artifact;
  const canonical = getAddress(address.toLowerCase());
  let answer;
  try {
    answer = await rules.checkDeploymentProof(chainFor(chainId), {
      message: deploymentMessage({ spec: draft, maker, stake }),
      chainId,
      address: canonical,
      signer,
      signature: proof.signature,
      creationTx: proof.creationTx ?? null,
    });
  } catch (err) {
    if (err instanceof ChainReadError) throw refuse('CHAIN_NOT_CHECKED');
    if (err instanceof BuilderError) throw err;
    throw new BuilderError('EXPLORER_UNAVAILABLE', `the deployment's chain could not be read: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  if (!answer.ok) throw refuse(answer.reason);
  return {
    signer,
    signature: proof.signature,
    creationTx: proof.creationTx ?? null,
    role: answer.role,
    contractSigner: answer.contractSigner,
    block: answer.block,
    stakeChainId: stake.chainId,
    stakeContract,
  };
}

/**
 * The whole proof of a listing, the build's `control` step.
 * @param {object} o
 * @param {object} o.draft
 * @param {string|null} o.maker - the address the listing's wallet is
 * @param {object|null} o.deploymentProof - { signer, signature, creationTx?, stakeChainId, stakeContract }
 * @param {object} o.config - parseConfig()
 * @param {(chainId: number) => object} o.chainFor - the listing's chain, as the proof check reads it
 * @param {object} [o.deps] - checkRepositoryControl
 * @returns {Promise<object>} report.control
 * @throws {Refusal|BuilderError}
 */
export async function checkListingProof({ draft, maker, deploymentProof, config, chainFor, deps = {} }) {
  if (maker === undefined || maker === null || maker === '') throw refuse('MAKER_REQUIRED');
  const canonical = rules.canonicalAddress(maker);
  if (!canonical) throw refuse('MAKER_INVALID');
  const repository = await checkRepositoryProof({ repo: draft.repo, baseCommit: draft.baseCommit, maker: canonical, config, deps });
  const deployment = draft.artifact?.kind === 'contract'
    ? await checkDeployment({ draft, maker: canonical, proof: deploymentProof, chainFor })
    : null;
  return { maker: canonical, repo: draft.repo, commit: draft.baseCommit, path: CONTROL_FILE, ref: repository.ref, blob: repository.blob, deployment };
}

/**
 * What `sign` repeats before it signs (it runs none of the maker's code, so it can read git itself):
 * the maker it was told is the report's, the repository's proof still stands, and a contract's
 * signature recovers to the signer the report names. Whether that signer is the deployment's owner
 * or deployer was read in the build job and is recorded as trusted (src/verifyBuild.js).
 * @throws {Refusal|BuilderError}
 */
export async function recheckForSigning({ spec, report, maker, config, deps = {} }) {
  const canonical = rules.canonicalAddress(maker);
  if (!canonical) throw new BuilderError('SIGNING_MAKER_REQUIRED', 'sign takes --maker, the wallet the listing was built for', { step: 'sign' });
  const control = report.control;
  if (!control || control.maker !== canonical || control.repo !== spec.repo || control.commit !== spec.baseCommit) {
    throw new BuilderError('SIGNING_MAKER_MISMATCH', `the validation report's proof is for ${control?.maker ?? 'nobody'}, not ${canonical}, at this repository and commit`, { step: 'sign' });
  }
  await checkRepositoryProof({ repo: spec.repo, baseCommit: spec.baseCommit, maker: canonical, config, deps });
  if (spec.artifact?.kind !== 'contract') return;
  const d = control.deployment;
  if (!d) throw new BuilderError('SIGNING_MAKER_MISMATCH', 'a contract listing\'s report records no deployment signature', { step: 'sign' });
  if (d.contractSigner) return; // its isValidSignature answered in the build job, on the chain
  let recovered = null;
  try {
    recovered = verifyMessage(deploymentMessage({ spec, maker: canonical, stake: { chainId: d.stakeChainId, address: d.stakeContract } }), d.signature);
  } catch { /* below */ }
  if (recovered !== d.signer) throw new BuilderError('SIGNING_MAKER_MISMATCH', 'the report\'s deployment signature does not recover to its signer', { step: 'sign' });
}
