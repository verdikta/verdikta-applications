// What the builder reads from @verdikta/common (pinned exactly, as every stake-attestation
// package does): the schemas and validators of code_review.json, baseline.json,
// known_issues.json and attestation.json, the pinned foundry base image, the class limits, the
// trusted-builder key set and the signing helpers. Only the codeReview module is loaded: the
// package's main entry brings an IPFS client the builder has no use for.
import codeReview from '@verdikta/common/src/codeReview/index.js';

export { codeReview };
