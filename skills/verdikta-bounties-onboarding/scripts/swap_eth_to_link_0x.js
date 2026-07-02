#!/usr/bin/env node
import './_env.js';
import { Contract, formatEther } from 'ethers';
import {
  getNetwork, providerFor, loadWallet, LINK, linkBalance, parseEth, arg,
  hasFlag, sendTx, confirmSpendOrExit, isDryRun, expectedChainId,
} from './_lib.js';

const ethAmount = arg('eth');
if (!ethAmount) {
  console.error('Usage: node swap_eth_to_link_0x.js --eth 0.02 --yes');
  console.error('Optional: --dry-run --allow-custom-0x');
  process.exit(1);
}

const network = getNetwork();
if (network !== 'base') {
  console.error('This script currently supports mainnet Base only (VERDIKTA_NETWORK=base).');
  process.exit(1);
}

const chainId = 8453;
const sellToken = 'ETH';
const buyToken = LINK[network];

const zeroX = process.env.ZEROX_BASE_URL || 'https://api.0x.org';
const apiKey = process.env.ZEROX_API_KEY;
const zeroXUrl = new URL(zeroX);

if (zeroXUrl.hostname !== 'api.0x.org' && !hasFlag('allow-custom-0x')) {
  console.error(`Refusing custom ZEROX_BASE_URL (${zeroX}) without --allow-custom-0x.`);
  process.exit(1);
}

const provider = providerFor(network);
const providerNetwork = await provider.getNetwork();
if (Number(providerNetwork.chainId) !== expectedChainId(network)) {
  console.error(`RPC chainId mismatch: got ${providerNetwork.chainId}, expected ${expectedChainId(network)} for ${network}. Refusing to swap.`);
  process.exit(1);
}
const wallet = await loadWallet();
const signer = wallet.connect(provider);

const sellAmountWei = parseEth(ethAmount);

// Quote + transaction
const url = new URL(`${zeroX}/swap/v1/quote`);
url.searchParams.set('chainId', String(chainId));
url.searchParams.set('sellToken', sellToken);
url.searchParams.set('buyToken', buyToken);
url.searchParams.set('sellAmount', sellAmountWei.toString());
url.searchParams.set('takerAddress', signer.address);
url.searchParams.set('slippagePercentage', '0.01');

const headers = { 'Accept': 'application/json' };
if (apiKey) headers['0x-api-key'] = apiKey;

const resp = await fetch(url, { headers });
if (!resp.ok) {
  const text = await resp.text();
  throw new Error(`0x quote failed: ${resp.status} ${text}`);
}
const quote = await resp.json();

if (!quote.to || typeof quote.to !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(quote.to)) {
  throw new Error('0x quote missing valid transaction recipient');
}
if (!quote.data || !/^0x([0-9a-fA-F]{2})*$/.test(quote.data)) {
  throw new Error('0x quote missing valid calldata');
}
if (quote.chainId != null && Number(quote.chainId) !== chainId) {
  throw new Error(`0x quote chainId mismatch: got ${quote.chainId}, expected ${chainId}`);
}
if (quote.buyTokenAddress && quote.buyTokenAddress.toLowerCase() !== buyToken.toLowerCase()) {
  throw new Error(`0x quote buy token mismatch: got ${quote.buyTokenAddress}, expected ${buyToken}`);
}

const txValue = BigInt(quote.value || sellAmountWei.toString());
if (txValue > sellAmountWei) {
  throw new Error(`0x quote value ${formatEther(txValue)} ETH exceeds requested sell amount ${formatEther(sellAmountWei)} ETH`);
}

console.log('\n0x swap quote');
console.log(`Network:       ${network}`);
console.log(`Wallet:        ${signer.address}`);
console.log(`Sell:          ${formatEther(sellAmountWei)} ETH`);
console.log(`Buy token:     ${buyToken}`);
if (quote.buyAmount) console.log(`Quoted buy:    ${quote.buyAmount} LINK base units`);
if (quote.estimatedPriceImpact) console.log(`Price impact:  ${quote.estimatedPriceImpact}`);
console.log(`0x endpoint:   ${zeroXUrl.origin}`);
console.log(`Tx recipient:  ${quote.to}`);
console.log(`Tx value:      ${formatEther(txValue)} ETH`);

if (isDryRun()) {
  console.log('\nDry run complete: quote fetched and validated. No swap transaction was signed.');
  process.exit(0);
}

await confirmSpendOrExit([
  `Action: swap ETH to LINK through 0x aggregator calldata`,
  `Network: ${network}`,
  `Wallet: ${signer.address}`,
  `Sell amount: ${formatEther(sellAmountWei)} ETH plus gas`,
  `Buy token: ${buyToken}`,
  `0x endpoint: ${zeroXUrl.origin}`,
  `Transaction recipient: ${quote.to}`,
]);

await sendTx(signer, '0x ETH→LINK swap', {
  to: quote.to,
  data: quote.data,
  value: txValue,
  gasLimit: quote.gas ? BigInt(quote.gas) : undefined,
  chainId,
}, {
  useApiGasLimit: Boolean(quote.gas),
  allowValue: true,
  maxValueWei: sellAmountWei,
  network,
});

const { bal, dec, linkAddr } = await linkBalance(network, provider, signer.address);
const link = new Contract(linkAddr, ['function symbol() view returns (string)'], provider);
const sym = await link.symbol();
const human = Number(bal) / (10 ** dec);
console.log(`LINK balance: ~${human.toFixed(4)} ${sym}`);
console.log(`ETH remaining: ${formatEther(await provider.getBalance(signer.address))}`);
