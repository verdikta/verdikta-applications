#!/usr/bin/env node
import './_env.js';
import { formatEther } from 'ethers';
import { getNetwork, providerFor, loadWallet } from './_lib.js';

const network = getNetwork();
const provider = providerFor(network);
const wallet = await loadWallet();
const address = wallet.address;

const ethBal = await provider.getBalance(address);
console.log('Funding status');
console.log('Network:', network);
console.log('Address:', address);
console.log('ETH:', formatEther(ethBal));
console.log('Current bounties use ETH for reward, gas and oracle prepay. A start attaches startValue (the oracle prepay plus the hunter bond the bounty sets), read immediately before starting; a re-run attaches requiredPrepay.');
