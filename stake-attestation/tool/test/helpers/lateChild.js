// A hunter process the late-claim tests kill (node P43): `commit --late` through the library over HTTP, which SIGKILLs
// itself on reaching LATE_STEP, so nothing after that point runs. crashChild.js, with `late: true`; that one is the
// ordinary commit's and is left as it is.
import { ethers } from 'ethers';

import { createHunter, createPinner } from '../../src/index.js';

const env = process.env;
const provider = new ethers.JsonRpcProvider(env.LATE_RPC, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
const hunter = createHunter({
  provider,
  signer: new ethers.Wallet(env.VERDIKTA_WALLET_KEY, provider),
  contract: env.LATE_CONTRACT,
  gateway: env.LATE_GATEWAY,
  pinner: createPinner({ backend: 'kubo', url: env.LATE_GATEWAY }),
  devKeys: [{ publicKey: env.LATE_DEV_KEY }],
  confirmations: 1,
  pollMs: 5,
  waitMs: 8000,
  readBackMs: 50,
  receiptGraceMs: 20,
  onNotice: () => {},
  onStep: (step) => {
    if (step === env.LATE_STEP) process.kill(process.pid, 'SIGKILL');
  },
});
await hunter.commit({ claimDir: env.LATE_DIR, listingId: BigInt(env.LATE_LISTING), late: env.LATE_ORDINARY !== '1', acknowledge: true });
