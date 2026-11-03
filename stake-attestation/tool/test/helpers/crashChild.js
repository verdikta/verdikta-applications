// A hunter process the crash tests kill: runs one verb through the library over HTTP, and SIGKILLs
// itself on reaching CRASH_STEP, so nothing after that point runs: no finally, no flush.
import { ethers } from 'ethers';

import { createHunter, createPinner } from '../../src/index.js';

const env = process.env;
const provider = new ethers.JsonRpcProvider(env.CRASH_RPC, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
const hunter = createHunter({
  provider,
  signer: new ethers.Wallet(env.VERDIKTA_WALLET_KEY, provider),
  contract: env.CRASH_CONTRACT,
  gateway: env.CRASH_GATEWAY,
  pinner: createPinner({ backend: 'kubo', url: env.CRASH_GATEWAY }),
  devKeys: [{ publicKey: env.CRASH_DEV_KEY }],
  confirmations: 1,
  pollMs: 5,
  waitMs: 8000,
  readBackMs: 50,
  receiptGraceMs: 20,
  onStep: (step) => {
    if (step === env.CRASH_STEP) process.kill(process.pid, 'SIGKILL');
  },
});
if (env.CRASH_VERB === 'commit') await hunter.commit({ claimDir: env.CRASH_DIR, listingId: BigInt(env.CRASH_LISTING), acknowledge: true });
else await hunter.reveal({ claimDir: env.CRASH_DIR });
