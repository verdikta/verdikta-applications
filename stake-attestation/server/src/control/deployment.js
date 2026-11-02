// A contract listing's proof, checked on the listing's chain: the rule is shared with the builder
// (shared/src/controlProof.js), with this package's ethers.
import { ChainReadError } from '@verdikta/stake-attestation-shared/control-proof';

import { controlProof } from './facts.js';

export { ChainReadError };
export const { checkDeploymentProof, EIP1271_MAGIC } = controlProof;
