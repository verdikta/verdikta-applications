#!/usr/bin/env node
import './_env.js';
import { ethers } from 'ethers';
import { getNetwork, providerFor, loadWallet, parseEth } from './_lib.js';

// Minimal on-chain bounty creation (no IPFS upload).
// Intended for testnet smoke tests.

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const network = getNetwork();
const provider = providerFor(network);
const wallet = await loadWallet();
const signer = wallet.connect(provider);

// Escrow addresses (fallbacks)
const ESCROW = {
  base: process.env.BOUNTY_ESCROW_ADDRESS_BASE || '0x0a6290EfA369Bbd4a9886ab9f98d7fAd7b0dc746',
  'base-sepolia': process.env.BOUNTY_ESCROW_ADDRESS_BASE_SEPOLIA || '0x0520b15Ee61C4E2A1B00bA260d8B1FBD015D2780'
};

const contractAddress = ESCROW[network];
if (!contractAddress) throw new Error(`Missing escrow address for network=${network}`);

const evaluationCid = arg('cid', 'QmRLB6LYe6VER6UQDoX7wt4LmKATHbGA81ny5vgRMbfrtX');
const classId = Number(arg('classId', '4')); // fallback class id
const threshold = Number(arg('threshold', '80'));
const hours = Number(arg('hours', '6'));
const amountEth = arg('eth', '0.001');

const deadline = Math.floor(Date.now() / 1000) + Math.floor(hours * 3600);
const value = parseEth(amountEth);

const ABI = [
  'function createBounty(string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline) payable returns (uint256)',
  'event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)'
];

const contract = new ethers.Contract(contractAddress, ABI, signer);

console.log('Creating bounty on-chain');
console.log('Network:', network);
console.log('Escrow:', contractAddress);
console.log('Creator:', signer.address);
console.log('CID:', evaluationCid);
console.log('classId:', classId);
console.log('threshold:', threshold);
console.log('deadline:', deadline, `(in ${hours}h)`);
console.log('value:', amountEth, 'ETH');

const tx = await contract.createBounty(evaluationCid, classId, threshold, deadline, { value });
console.log('Tx:', tx.hash);
const receipt = await tx.wait();

let bountyId = null;
for (const log of (receipt.logs || [])) {
  try {
    const parsed = contract.interface.parseLog(log);
    if (parsed?.name === 'BountyCreated') {
      bountyId = String(parsed.args.bountyId ?? parsed.args[0]);
      break;
    }
  } catch {}
}

console.log('Confirmed in block:', receipt.blockNumber);
console.log('BountyId:', bountyId ?? '(not parsed)');
