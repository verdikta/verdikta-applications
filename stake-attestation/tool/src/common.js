// What the tool reads from @verdikta/common (pinned exactly, as every stake-attestation package does):
// the schemas and validators, the disclosure scheme, the panels and the claim query. Never local copies:
// a claim is exactly what the arbiters read.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const common = require('@verdikta/common');

export const { codeReview, BCID_QUERY_MAX_CHARS, QUERY_MIN_CHARS } = common;
