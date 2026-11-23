// The tests run against a SYNTHETIC v2 escrow deployment: scripts/deployments.json holds placeholders (no address or
// codeHash) until the reviewed v2 deployment is recorded, and every escrow script refuses on them. Import this first,
// before anything that reads deployments at import time (_lib.js's ESCROW). The address is a made-up test value and
// the code hash is keccak256 of the stub bytecode the tests' providers return; neither is a real deployment.
import { getAddress, keccak256 } from 'ethers';
import { deployments } from '../_transaction-guards.js';

export const PLACEHOLDERS = structuredClone(deployments);
export const SYNTHETIC_CODE = '0x1234';
const synthetic = {
  base: getAddress('0x' + 'e5'.repeat(20)),
  // The escrow the captured testnet wager fixtures (fixtures/wager-*) name in their terms lines, so they still read
  // as posted on this site. Test-only: it is the v1 testnet escrow, never used by the scripts themselves.
  'base-sepolia': getAddress('0x1B4F0e43256d435DfcD5C0883799F0Eb3943e08f'),
};
export function installSynthetic() {
  for (const [network, address] of Object.entries(synthetic)) {
    const d = deployments[network];
    delete d.status;
    Object.assign(d, { address, codeHash: keccak256(SYNTHETIC_CODE), observedAt: 'synthetic test deployment' });
  }
}
/** Runs fn with deployments.json's real placeholders back in place, then reinstalls the synthetic deployment. */
export async function withPlaceholders(fn) {
  for (const network of Object.keys(synthetic)) {
    for (const key of Object.keys(deployments[network])) delete deployments[network][key];
    Object.assign(deployments[network], structuredClone(PLACEHOLDERS[network]));
  }
  try { return await fn(); } finally { installSynthetic(); }
}
installSynthetic();
