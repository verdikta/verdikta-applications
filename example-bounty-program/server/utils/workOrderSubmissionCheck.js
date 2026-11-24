/**
 * Work-order submission check
 *
 * Checks a submission to a real-world-task-v1 work-order bounty BEFORE the hunter pays
 * for an evaluation: is there a result.json, do the evidence file names it lists match
 * files that are actually attached, does it carry the bounty's request digest, and does
 * it validate against the template's result schema.
 *
 * Written after mainnet bounty 398 (November 2026). Two of its three submissions listed
 * E1_token_photo.jpg, E2_frame_t005.png, evidence.md and so on in a result file whose
 * archive held IMG_1094.jpeg, R2.md, r1.json: not one listed name existed, and no file
 * was called result.json. The rubric's first gate asks for every evidence item "listed
 * in result.json with its filename". skills/verdikta-discover/tests/bounty-398-submissions.json
 * holds those three submissions as test cases.
 *
 * What blocks and what warns:
 *   errors   (the submit routes refuse the upload) are facts the hunter can fix by
 *            renaming a file or correcting one field, and that the rubric or the bounty
 *            description states outright: no result.json, a listed file that is not
 *            attached, an input_sha256 that is not this bounty's request digest.
 *   warnings (returned with the upload) are things a jury may still accept or that this
 *            server cannot judge: result-schema and coverage errors (all three bounty-398
 *            results passed them, and a juror cannot run a schema validator), PDF
 *            attachments and a large total size.
 */

const crypto = require('crypto');
const path = require('path');
const logger = require('./logger');

const TEMPLATE_ID = 'real-world-task-v1';
const RESULT_NAME = 'result.json';
const DIGEST_PREFIX = 'Request bytes SHA-256 (result.input_sha256): ';
const REQUEST_MARKER = 'Request (exact UTF-8 JSON bytes, no trailing newline):';
// result.json is a few KB; anything larger is not parsed.
const MAX_RESULT_BYTES = 1024 * 1024;
// Bounty 398: archives of 3.3 and 3.7 MB (four images) took the slower juror 82-116 s of
// the arbiters' 120 s model timeout, and timed out in two of six runs.
const LARGE_SUBMISSION_BYTES = 5 * 1024 * 1024;
const FULFILMENT_GUIDE = 'https://raw.githubusercontent.com/verdikta/verdikta-applications/refs/heads/main/skills/verdikta-discover/references/fulfilment.md';

/**
 * The work order a job's description commits to, or null when the job is not a
 * real-world-task-v1 work order. Reads only the description (the same lines
 * skills/verdikta-discover/scripts/work-order.mjs parseWorkOrderDescription reads), so
 * it needs none of that skill's packages.
 * @returns {{ templateId: string, requestDigest: string, request: object|null } | null}
 */
function workOrderOf(job) {
  const text = job && typeof job.description === 'string' ? job.description : null;
  if (!text) return null;
  const lines = text.split('\n');
  if (!lines.includes(`Service: ${TEMPLATE_ID}`)) return null;
  const digestLine = lines.find((l) => l.startsWith(DIGEST_PREFIX));
  const requestDigest = digestLine ? digestLine.slice(DIGEST_PREFIX.length).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) return null;
  // The request is used only for the schema-and-coverage warning, and only when its
  // bytes still hash to the stated digest (a healed or truncated description may not).
  let request = null;
  const at = lines.indexOf(REQUEST_MARKER);
  if (at >= 0 && at + 1 < lines.length) {
    const line = lines[at + 1];
    if (crypto.createHash('sha256').update(line, 'utf8').digest('hex') === requestDigest) {
      try { request = JSON.parse(line); } catch { request = null; }
    }
  }
  return { templateId: TEMPLATE_ID, requestDigest, request };
}

// The discover skill's validator (ESM, with its own ajv). Loaded on first use; a server
// deployed without that directory or its packages still runs every other check.
let validatorsPromise = null;
function loadSkillValidators() {
  validatorsPromise ||= import('../../../skills/verdikta-discover/scripts/validation.mjs')
    .catch((error) => {
      logger.warn('[workOrderSubmissionCheck] result validator unavailable; schema check skipped', { msg: error.message });
      return null;
    });
  return validatorsPromise;
}

function parseObject(buffer) {
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

const looksLikeResult = (value) => !!value && Array.isArray(value.evidence) && typeof value.input_sha256 === 'string';

/**
 * @param {object} job  the bounty record (its description decides whether the check applies)
 * @param {Array<{ name: string, size?: number, read: () => Promise<Buffer> }>} files
 *        the attached files by the name the archive will carry
 * @param {{ loadValidators?: () => Promise<{ validateResult: Function } | null> }} [opts]
 * @returns {Promise<{ applies: false } | { applies: true, templateId: string, ok: boolean,
 *   resultFile: string|null, errors: Array<object>, warnings: Array<object> }>}
 */
async function checkWorkOrderSubmission(job, files, opts = {}) {
  const order = workOrderOf(job);
  if (!order) return { applies: false };
  const { loadValidators = loadSkillValidators } = opts;
  const errors = [];
  const warnings = [];
  const names = files.map((f) => f.name);
  const done = (resultFile) => ({ applies: true, templateId: order.templateId, ok: errors.length === 0, resultFile, errors, warnings });

  sizeWarnings(files, warnings);

  // ---- result.json: present, by that exact name, and a JSON object ----
  const readSmall = async (f) => ((f.size ?? 0) > MAX_RESULT_BYTES ? null : f.read());
  let resultFile = files.find((f) => f.name === RESULT_NAME) || null;
  let result = null;
  if (resultFile) {
    const bytes = await readSmall(resultFile);
    result = bytes && parseObject(bytes);
    if (!result) {
      errors.push({
        code: 'WORK_ORDER_RESULT_NOT_JSON',
        message: 'result.json is not a JSON object',
        fix: `Deliver result.json as one JSON object that validates against the ${order.templateId} result schema (${FULFILMENT_GUIDE}).`,
      });
      return done(RESULT_NAME);
    }
  } else {
    // A result delivered under another name (bounty 398: r1.json, R1.json) is still read,
    // so the file-name findings below can be reported in the same response.
    const candidates = [];
    for (const f of files.filter((x) => /\.json$/i.test(x.name))) {
      const bytes = await readSmall(f);
      const value = bytes && parseObject(bytes);
      if (looksLikeResult(value)) candidates.push({ file: f, value });
    }
    if (candidates.length === 1) {
      resultFile = candidates[0].file;
      result = candidates[0].value;
      errors.push({
        code: 'WORK_ORDER_RESULT_MISNAMED',
        message: `No attached file is named result.json (${resultFile.name} looks like the result)`,
        fix: `Rename ${resultFile.name} to result.json. The rubric and the delivery note name that file, and the jury is shown each attachment's file name.`,
      });
    } else {
      errors.push({
        code: 'WORK_ORDER_RESULT_MISSING',
        message: 'No attached file is named result.json',
        fix: `A ${order.templateId} submission delivers result.json, a readable evidence.md and every evidence file result.json names (${FULFILMENT_GUIDE}).`,
      });
      return done(null);
    }
  }

  // ---- every evidence file name result.json lists is an attached file ----
  const listed = [...new Set((Array.isArray(result.evidence) ? result.evidence : [])
    .map((e) => e && e.filename).filter((n) => typeof n === 'string' && n))];
  const unmatched = listed.filter((n) => !names.includes(n));
  if (unmatched.length) {
    const hint = (n) => {
      const near = names.find((x) => x.toLowerCase() === n.toLowerCase());
      return near ? `${n} (attached as ${near}: case differs)` : n;
    };
    errors.push({
      code: 'WORK_ORDER_FILES_UNMATCHED',
      message: `${resultFile.name} lists ${unmatched.length} evidence file${unmatched.length > 1 ? 's' : ''} that ${unmatched.length > 1 ? 'are' : 'is'} not attached`,
      details: `Listed but not attached: ${unmatched.map(hint).join(', ')}. Attached: ${names.join(', ')}.`,
      unmatched,
      attached: names,
      fix: 'Give each attached file the exact name result.json lists for it (or correct the filename fields), so every evidence entry names a file in this upload. The first must-pass criterion wants every evidence item "listed in result.json with its filename".',
    });
  }

  // ---- input_sha256 is this bounty's request digest ----
  if (result.input_sha256 !== order.requestDigest) {
    errors.push({
      code: 'WORK_ORDER_DIGEST_MISMATCH',
      message: 'result.json input_sha256 is not this bounty\'s request digest',
      details: `Expected ${order.requestDigest}; result.json carries ${JSON.stringify(result.input_sha256 ?? null)}.`,
      fix: 'Copy the value after "Request bytes SHA-256 (result.input_sha256):" in the bounty description into input_sha256. A different value means the result answers another request.',
    });
  }

  // ---- result schema and coverage (the skill's own validator) ----
  const validators = order.request ? await loadValidators() : null;
  if (!validators || typeof validators.validateResult !== 'function') {
    warnings.push({
      code: 'WORK_ORDER_SCHEMA_UNCHECKED',
      message: 'result.json was not checked against the result schema here',
      fix: 'Run the offline check before paying for an evaluation: node scripts/check-result.bundle.mjs --description description.txt --result result.json --files <every file you attach> (skills/verdikta-discover).',
    });
  } else {
    const found = validators.validateResult(order.templateId, order.request, result, order.requestDigest, { production: true })
      // The digest has its own blocking finding above.
      .filter((e) => !(e === 'Request identity/digest mismatch' && result.task_id === order.request.task_id));
    if (found.length) {
      warnings.push({
        code: 'WORK_ORDER_RESULT_INVALID',
        message: `result.json does not pass the ${order.templateId} result check (${found.length} finding${found.length > 1 ? 's' : ''})`,
        details: found.slice(0, 20),
        fix: `Fix result.json against the result schema and the request (${FULFILMENT_GUIDE}). The upload is not refused for this, but the jury's first gate reads result.json.`,
      });
    }
  }
  return done(resultFile.name);
}

function sizeWarnings(files, warnings) {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name)).map((f) => f.name);
  if (pdfs.length) {
    warnings.push({
      code: 'WORK_ORDER_PDF_EVIDENCE',
      message: `${pdfs.join(', ')}: a PDF reaches the jury as extracted text, or not at all`,
      fix: 'Attach anything the jury must look at (photographs, recording frames, screenshots) as separate image files. A PDF of images gives a juror no images: until every arbiter passes PDFs to the models, only its text is extracted, and a large image-only PDF is skipped.',
    });
  }
  const total = files.reduce((n, f) => n + (f.size || 0), 0);
  if (total > LARGE_SUBMISSION_BYTES) {
    warnings.push({
      code: 'WORK_ORDER_LARGE_SUBMISSION',
      message: `The attachments total ${(total / (1024 * 1024)).toFixed(1)} MB`,
      fix: 'Keep the whole submission under about 5 MB and each image near 1 MB or less (JPEG for photographs, about 1600-2000 px on the long side). Larger packs have made a jury model run out of its time limit, which leaves the round to the other jurors.',
    });
  }
}

/** The check's input for files multer wrote to disk ({ originalname, size, path }). */
function uploadedFileInputs(uploadedFiles, fsPromises = require('fs').promises) {
  return (uploadedFiles || []).map((f) => ({ name: f.originalname, size: f.size, read: () => fsPromises.readFile(f.path) }));
}

/**
 * The check's input for a submission archive already built or pinned: the files its
 * manifest lists, by base name. Returns null when the archive cannot be listed.
 * @param {Buffer} buffer
 */
function archiveFileInputs(buffer) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry || manifestEntry.header.size > MAX_RESULT_BYTES) return null;
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    if (!Array.isArray(manifest.additional)) return null;
    const inputs = [];
    for (const a of manifest.additional) {
      if (!a || typeof a.filename !== 'string') continue;
      const entry = zip.getEntry(a.filename);
      if (!entry) continue;
      inputs.push({ name: path.posix.basename(a.filename), size: entry.header.size, read: async () => entry.getData() });
    }
    return inputs;
  } catch { return null; }
}

/** The 400 body a submit route sends when the check has blocking errors. */
function workOrderErrorBody(check) {
  return {
    success: false,
    code: 'WORK_ORDER_CHECK_FAILED',
    error: `Submission does not match this ${check.templateId} work order: ${check.errors.map((e) => e.message).join('; ')}`,
    details: check.errors.map((e) => e.details || e.message).join(' '),
    fix: check.errors.map((e) => e.fix).join(' '),
    workOrderCheck: check,
    tips: [
      'Nothing was pinned and nothing was spent: fix the files and upload again.',
      'POST /api/jobs/:id/submit/dry-run runs the same check without uploading.',
    ],
  };
}

module.exports = {
  TEMPLATE_ID,
  LARGE_SUBMISSION_BYTES,
  workOrderOf,
  checkWorkOrderSubmission,
  uploadedFileInputs,
  archiveFileInputs,
  workOrderErrorBody,
};
