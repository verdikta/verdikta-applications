#!/usr/bin/env node
// Withdraw this wallet's ETH, or LINK left by the retired swap, to the owner address recorded at onboarding.
// There is deliberately no destination option: the owner changes the address with `node onboard.js --set-owner`.
import { isMain } from './_cli.js';
import { parseUnits } from 'ethers';
import { ownerTransferTokens } from './_transaction-guards.js';

const USAGE = 'Usage: withdraw_to_owner.js (--amount <decimal> | --all) [--asset ETH|LINK] [--dry-run] [--yes]';

export async function runWithdraw(lib, owners, argv = process.argv.slice(2)) {
  const { getNetwork, providerFor, loadWallet, loadSpendPolicy, isDryRun, confirmSpendOrExit } = lib;
  const { loadOwnerAddress, withdrawToOwner, SET_OWNER } = owners;
  let asset = 'ETH', amountText = null, all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--amount') amountText = argv[++i] ?? '';
    else if (a === '--asset') asset = String(argv[++i] ?? '').toUpperCase();
    else if (['--dry-run', '--dryRun', '--yes', '--confirm-spend'].includes(a)) continue;
    else if (/^--(to|address|destination|recipient|owner)(=|$)/.test(a)) throw new Error(`There is no ${a.split('=')[0]} option: withdrawals go only to the owner address recorded at onboarding. The owner changes it with \`${SET_OWNER}\` in their own terminal.`);
    else throw new Error(`Unknown argument ${a}. ${USAGE}`);
  }
  const network = getNetwork();
  const decimals = asset === 'ETH' ? 18 : ownerTransferTokens[network]?.[asset]?.decimals;
  if (decimals == null || all === (amountText != null) || (!all && !/^[0-9]+(\.[0-9]+)?$/.test(amountText))) throw new Error(USAGE);
  const amount = all ? 'all' : parseUnits(amountText, decimals);
  if (amount === 0n) throw new Error(`Withdrawal amount must be positive. ${USAGE}`);
  // The destination is read before the wallet is unlocked, so a missing or overridden record stops here.
  const owner = await loadOwnerAddress();
  console.log(`Owner withdrawal address (recorded at onboarding): ${owner}`);
  const provider = providerFor(network);
  try {
    const policy = await loadSpendPolicy(), signer = (await loadWallet()).connect(provider);
    return await withdrawToOwner(signer, { network, owner, asset, amount, policy, dryRun: isDryRun(), confirm: confirmSpendOrExit });
  } finally { provider.destroy(); }
}

if (isMain(import.meta.url)) {
  await runWithdraw(await import('./_lib.js'), await import('./_owner.js'));
}
