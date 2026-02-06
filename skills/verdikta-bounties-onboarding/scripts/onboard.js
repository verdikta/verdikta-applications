#!/usr/bin/env node
import './_env.js';
// Interactive onboarding: wallet → funding instructions → (mainnet) optional swap ETH→LINK → optional sweep.

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs/promises';
import { formatEther, formatUnits, Contract } from 'ethers';
import { getNetwork, providerFor, loadWallet, LINK, ERC20_ABI } from './_lib.js';

function envNum(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    const network = process.env.VERDIKTA_NETWORK || 'base';
    console.log('Verdikta Bounties bot onboarding');
    console.log('Network:', network);

    // Wallet must already exist (created via wallet_init.js)
    const wallet = await loadWallet();
    const provider = providerFor(network);
    const address = wallet.address;

    console.log('\nBot wallet address (fund this):', address);

    console.log('\nFunding requirements:');
    console.log('- ETH on Base for gas');
    console.log('- LINK on Base for judgement fees (first release)');

    if (network !== 'base') {
      console.log('\nTestnet mode:');
      console.log('- Please fund ETH + LINK manually to the bot address above.');
      console.log('- Devs can handle this; bot will not attempt swaps on testnet.');
    }

    const ethBal = await provider.getBalance(address);
    console.log('\nCurrent ETH balance:', formatEther(ethBal));

    // Mainnet: offer swap via 0x
    if (network === 'base') {
      const convert = (await rl.question('\nConvert some ETH to LINK now? (y/N) ')).trim().toLowerCase();
      if (convert === 'y' || convert === 'yes') {
        console.log('Run: node swap_eth_to_link_0x.js --eth <amount>');
        console.log('Tip: start small (e.g. 0.01 ETH) until you confirm everything works.');
      }
    }

    // Optional sweep policy
    const sweep = (await rl.question('\nEnable sweep of excess ETH to off-bot address? (y/N) ')).trim().toLowerCase();
    if (sweep === 'y' || sweep === 'yes') {
      const off = (await rl.question('Off-bot address (0x...): ')).trim();
      const thresholdUsd = envNum('SWEEP_USD_THRESHOLD', 100);
      const ethUsdPrice = envNum('ETH_USD_PRICE', 3000);
      const thresholdEth = thresholdUsd / ethUsdPrice;
      console.log(`\nSuggested threshold: ~$${thresholdUsd} ≈ ${thresholdEth.toFixed(4)} ETH (edit SWEEP_USD_THRESHOLD/ETH_USD_PRICE)`);
      console.log('NOTE: Sweep execution not automated in this script yet; this config is instructional for now.');
      await fs.writeFile('../secrets/sweep.json', JSON.stringify({ offbot: off, thresholdUsd, ethUsdPrice }, null, 2), { mode: 0o600 }).catch(()=>{});
      console.log('Saved sweep config to ../secrets/sweep.json (if writable).');
    }

    // Show balances summary
    const linkAddr = LINK[network];
    const link = new Contract(linkAddr, ERC20_ABI, provider);
    const [lbal, dec] = await Promise.all([link.balanceOf(address), link.decimals()]);
    const linkHuman = Number(formatUnits(lbal, dec));

    console.log('\nBalance summary');
    console.log('ETH:', formatEther(await provider.getBalance(address)));
    console.log('LINK:', linkHuman.toFixed(6));

    console.log('\nNext: register bot for API key, then run worker:');
    console.log('  node bot_register.js --name "MyBot" --owner 0xYourOwnerAddress');
    console.log('  node bounty_worker_min.js');

    console.log('\nPrivate key handling:');
    console.log('- Keystore path:', process.env.VERDIKTA_KEYSTORE_PATH || '(set VERDIKTA_KEYSTORE_PATH)');
    console.log('- To export (DANGEROUS): node export_private_key.js --i-know-what-im-doing > private_key.txt');
    console.log('  Do NOT paste private keys into chat.');

  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error('Onboarding failed:', e?.message || e);
  process.exit(1);
});
