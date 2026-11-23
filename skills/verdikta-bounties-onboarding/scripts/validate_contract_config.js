#!/usr/bin/env node
// Non-spending guardrail: verify local escrow defaults match the live agent docs.

import './_env.js';
import { getNetwork } from './_lib.js';
import { escrowAddress } from './_transaction-guards.js';

const NETWORK_DOCS = {
  base: 'https://bounties.verdikta.org/agents.txt',
  'base-sepolia': 'https://bounties-testnet.verdikta.org/agents.txt',
};

const network = getNetwork();
const docsUrl = NETWORK_DOCS[network];
if (!docsUrl) {
  console.error(`Unsupported network for contract validation: ${network}`);
  process.exit(1);
}
let localEscrow;
try { localEscrow = escrowAddress(network); } // "not deployed yet" while deployments.json holds the v2 placeholder
catch (error) { console.error(error.message); process.exit(1); }

const res = await fetch(docsUrl);
if (!res.ok) {
  console.error(`Failed to fetch ${docsUrl}: HTTP ${res.status}`);
  process.exit(1);
}

const text = await res.text();
const match = text.match(/BountyEscrow:\s*(0x[a-fA-F0-9]{40})/);
if (!match) {
  console.error(`Could not find BountyEscrow address in ${docsUrl}`);
  process.exit(1);
}

const docsEscrow = match[1];
if (docsEscrow.toLowerCase() !== localEscrow.toLowerCase()) {
  console.error('BountyEscrow mismatch; refusing to validate config.');
  console.error(`  Network:      ${network}`);
  console.error(`  Local ESCROW: ${localEscrow}`);
  console.error(`  Docs expect:  ${docsEscrow}`);
  process.exit(1);
}

console.log(`BountyEscrow config OK (${network}): ${localEscrow}`);
