// A contract listing's proof, checked on the listing's chain (node P8, acceptance 2): a signature of
// the listing's message (facts.js controlMessage) from the deployment's current owner (owner(),
// EIP-173's read) or its deployer (the transaction that created it, given by its hash, so a reader
// can look it up: tx.from is the signer and its receipt's contractAddress is the deployment; a
// deployment made through a factory has no such transaction and is proved by its owner). A signer
// with code answers through EIP-1271's isValidSignature; every other signer's signature is recovered.
// Every read is of one block, which the record states.
import { Interface, getAddress, hashMessage, verifyMessage } from 'ethers';

export const EIP1271_MAGIC = '0x1626ba7e';
const MAGIC_WORD = `${EIP1271_MAGIC}${'0'.repeat(56)}`;
const OWNER_CALL = new Interface(['function owner() view returns (address)']).encodeFunctionData('owner');
const EIP1271 = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const ADDRESS_WORD = /^0x0{24}([0-9a-fA-F]{40})$/;
const ZERO = '0x0000000000000000000000000000000000000000';

/** A chain read that may answer nothing, in a form a fact can state. */
export class ChainReadError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'ChainReadError';
    this.code = code;
  }
}

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

/** Whether `signer` signed `message`: { valid, contract }. */
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
 * @param {import('ethers').JsonRpcApiProvider} provider - on the listing's chain
 * @param {object} o
 * @param {string} o.message - controlMessage's text for the listing
 * @param {number|bigint} o.chainId - the listing's chain
 * @param {string} o.address - the deployment
 * @param {string} o.signer - EIP-55
 * @param {string} o.signature
 * @param {string|null} o.creationTx
 * @returns {Promise<{ ok: true, role: 'owner'|'deployer', contractSigner: boolean, block: number } | { ok: false, reason: string }>}
 * @throws {ChainReadError} CHAIN_NOT_CHECKED (the provider is on another chain); anything else the
 *   provider throws means the chain could not be read
 */
export async function checkDeploymentProof(provider, { message, chainId, address, signer, signature, creationTx }) {
  const answered = BigInt(await provider.send('eth_chainId', []));
  if (answered !== BigInt(chainId)) throw new ChainReadError('CHAIN_NOT_CHECKED', `the provider is on chain ${answered}, not ${chainId}`);
  const block = await provider.getBlockNumber();
  const code = await provider.getCode(address, block);
  if (!code || code === '0x') return { ok: false, reason: 'NO_CONTRACT_AT_ADDRESS' };

  const { valid, contract } = await signatureCheck(provider, { message, signer, signature, blockTag: block });
  if (!valid) return { ok: false, reason: 'SIGNATURE_INVALID' };

  if ((await ownerOf(provider, address, block)) === signer) return { ok: true, role: 'owner', contractSigner: contract, block };
  if (creationTx) {
    const [tx, receipt] = await Promise.all([provider.getTransaction(creationTx), provider.getTransactionReceipt(creationTx)]);
    if (tx && receipt && receipt.status === 1 && receipt.blockNumber <= block && tx.from === signer && receipt.contractAddress === address) {
      return { ok: true, role: 'deployer', contractSigner: contract, block };
    }
  }
  return { ok: false, reason: 'SIGNER_NOT_CONTROLLER' };
}
