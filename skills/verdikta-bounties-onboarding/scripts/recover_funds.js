#!/usr/bin/env node
// Explicit maintenance: close an expired bounty or withdraw this signer's pull-ledger ETH.
import { Contract } from 'ethers';
import { arg, hasFlag, getNetwork, providerFor, loadWallet, preflightDeployment, loadSpendPolicy, sendTx } from './_lib.js';
import { abi, iface, deployments, reviewedApiOrigin } from './_transaction-guards.js';
const withdraw = hasFlag('withdraw'), jobId = arg('close');
if (withdraw === (jobId != null)) throw new Error('Select exactly --withdraw OR --close BOUNTY_ID');
const network = getNetwork(), provider = providerFor(network);
await preflightDeployment(network, provider, reviewedApiOrigin(network, process.env.VERDIKTA_BOUNTIES_BASE_URL));
const policy = await loadSpendPolicy(), signer = (await loadWallet()).connect(provider);
const escrow = new Contract(deployments[network].address, abi, provider);
if (withdraw && await escrow.withdrawable(signer.address) === 0n) throw new Error('No pull-ledger balance for this signer');
if (!withdraw && (!/^[0-9]+$/.test(jobId) || !await escrow.canBeClosed(jobId))) throw new Error('Bounty cannot be closed; pending evaluations may need resolution');
const method = withdraw ? 'withdraw' : 'closeExpiredBounty', args = withdraw ? [] : [BigInt(jobId)];
const tx = { to: deployments[network].address, chainId: deployments[network].chainId, data: iface.encodeFunctionData(method, args), value: '0' };
await sendTx(signer, method, tx, { network, args, policy });
provider.destroy();
