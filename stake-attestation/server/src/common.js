// What the server reads from @verdikta/common (pinned exactly, as every stake-attestation package
// does): the code-review schemas and validators, buildClaimQuery, the code classes and their
// panels, parseDisclosureKey, and the manifest validator, ManifestParser and ArchiveService the
// External Adapter reads a listing archive with. The listing archive is built from these and
// checked with these, never with local copies, because it is exactly what arbiters judge.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const common = require('@verdikta/common');

export const { codeReview, validator, ArchiveService, ManifestParser, PRIMARY_QUERY_MAX_CHARS } = common;
