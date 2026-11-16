// common's production verification over a signed folder, in a process with the same trust stub as the sign.
import fs from 'node:fs';
import path from 'node:path';

import { codeReview } from '../../src/common.js';

const [dir] = process.argv.slice(2);
const read = (name) => fs.readFileSync(path.join(dir, name));
const spec = JSON.parse(read('code_review.json').toString('utf8'));
const attestation = JSON.parse(read('attestation.json').toString('utf8'));
const validation = codeReview.validateAttestation(attestation, { files: { codeReview: read('code_review.json'), baseline: read(spec.baseline) } });
process.stdout.write(`${JSON.stringify({ ok: validation.ok, codes: validation.issues.map((i) => i.code), trust: attestation.trust, keyId: attestation.signature.keyId })}\n`);
