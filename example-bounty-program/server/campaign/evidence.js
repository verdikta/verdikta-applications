'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const {
  fetchArchiveBuffer,
  validateArchiveShape,
} = require('../utils/archiveShapeValidator');
const { buildEvaluationQuery } = require('../utils/archiveGenerator');
const { sha256, canonicalRubric, snapshotDigest } = require('./config');
const { evidenceError } = require('./cache');
const CID = /^[a-zA-Z0-9]{46,100}$/;
async function fetchCid(cid) {
  if (!CID.test(cid)) throw evidenceError('INVALID_CID');
  try {
    return await fetchArchiveBuffer(cid, {
      maxBytes: 4 * 1024 * 1024,
      totalTimeoutMs: 10000,
    });
  } catch (error) {
    throw evidenceError(
      error.tooLarge ? 'ARCHIVE_TOO_LARGE' : 'GATEWAY_UNAVAILABLE',
      !!error.tooLarge,
      cid,
    );
  }
}
function archive(buffer) {
  try {
    if (buffer.length > 4 * 1024 * 1024) throw new Error();
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (
      entries.length > 100 ||
      new Set(entries.map((entry) => entry.entryName)).size !==
        entries.length ||
      entries.reduce((total, entry) => total + entry.header.size, 0) >
        8 * 1024 * 1024
    )
      throw new Error();
    const bytes = (filename) => {
      const entry = zip.getEntry(filename);
      if (!entry || entry.header.size > 1024 * 1024 || entry.isDirectory)
        throw evidenceError('INVALID_PACKAGE');
      return entry.getData();
    };
    return {
      bytes,
      text: (filename) => bytes(filename).toString('utf8'),
      json: (filename) => JSON.parse(bytes(filename).toString('utf8')),
    };
  } catch {
    throw evidenceError('INVALID_PACKAGE');
  }
}
async function modules() {
  const [workOrder, core, validation] = await Promise.all([
    import('../../../skills/verdikta-discover/scripts/work-order.mjs'),
    import('../../../skills/verdikta-discover/scripts/preview-core.mjs'),
    import('../../../skills/verdikta-discover/scripts/validation.mjs'),
  ]);
  return { ...workOrder, ...core, ...validation };
}
async function templateDigests() {
  const shared = await modules();
  return Object.entries(shared.templates).map(([id, template]) => {
    const snapshot = {
      id,
      version: template.template_version,
      rubric: JSON.parse(
        fs.readFileSync(
          path.join(
            __dirname,
            '../../../skills/verdikta-discover/templates',
            `${id}.rubric.json`,
          ),
          'utf8',
        ),
      ),
      threshold: template.recommended_threshold,
    };
    return { ...snapshot, sha256: snapshotDigest(snapshot) };
  });
}
async function inspectBounty(bounty, config, fetcher = fetchCid) {
  const evaluationBytes = await fetcher(bounty.evaluationCid);
  try {
    const shared = await modules();
    const evaluationArchive = archive(evaluationBytes);
    const manifest = evaluationArchive.json('manifest.json');
    const primary = evaluationArchive.json(manifest.primary?.filename);
    if (typeof primary.query !== 'string' || !primary.query.trim())
      throw evidenceError('INVALID_PACKAGE');
    const references = manifest.additional?.filter(
      (reference) => reference.name === 'gradingRubric',
    );
    if (references?.length !== 1 || references[0].type !== 'ipfs/cid')
      throw evidenceError('INVALID_PACKAGE');
    const rubric = JSON.parse(
      (await fetcher(references[0].hash)).toString('utf8'),
    );
    if (!Array.isArray(rubric.criteria) || !rubric.criteria.length)
      throw evidenceError('INVALID_PACKAGE');
    const common = {
      ok: true,
      evaluationCid: bounty.evaluationCid,
      rubricCid: references[0].hash,
    };
    const parsed = shared.parseWorkOrderDescription(primary.query);
    if (!parsed) {
      return {
        ...common,
        kind: 'custom',
        scopeDigest: sha256(primary.query),
        classification: 'NOT_A_WORK_ORDER',
      };
    }
    const prefixes = [
      'Service: ',
      'Request bytes SHA-256 (result.input_sha256): ',
      'Approved work-order draft SHA-256: ',
      'Request (exact UTF-8 JSON bytes, no trailing newline):',
    ];
    if (
      prefixes.some(
        (prefix) =>
          primary.query.split('\n').filter((line) => line.startsWith(prefix))
            .length !== 1,
      )
    )
      throw evidenceError('NOT_A_WORK_ORDER');
    if (
      parsed.errors.length ||
      parsed.request.fixture_only ||
      shared.validateRequest(parsed.templateId, parsed.request).length
    )
      throw evidenceError('WORK_ORDER_HASH_OR_REQUEST_INVALID');
    const snapshot = config.approvedTemplates.find(
      (candidate) =>
        candidate.id === parsed.templateId &&
        bounty.threshold === candidate.threshold &&
        shared.sameJson(
          canonicalRubric(rubric),
          canonicalRubric(candidate.rubric),
        ),
    );
    if (!snapshot) throw evidenceError('RUBRIC_MISMATCH');
    if (
      !shared.sameJson(primary.outcomes, ['DONT_FUND', 'FUND']) ||
      !shared.sameJson(primary.references, ['gradingRubric'])
    )
      throw evidenceError('INVALID_PACKAGE');
    const match = primary.query.match(
      /^WORK PRODUCT EVALUATION REQUEST[\s\S]*?=== TASK DESCRIPTION ===\nWork Product Type: ([^\n]+)\nTask Title: ([^\n]+)\nTask Description: ([\s\S]*?)\n\n=== EVALUATION PROTOCOL ===/,
    );
    if (!match) throw evidenceError('NOT_A_WORK_ORDER');
    const rebuilt = buildEvaluationQuery({
      workProductType: match[1],
      jobTitle: match[2],
      jobDescription: match[3],
      rubricCriteria: rubric.criteria,
      forbiddenContent: rubric.forbiddenContent ?? rubric.forbidden_content,
    });
    if (rebuilt !== primary.query)
      throw evidenceError('EVALUATION_QUERY_CHANGED');
    return {
      ...common,
      kind: 'workOrder',
      templateId: parsed.templateId,
      templateVersion: snapshot.version,
      templateSha256: snapshot.sha256,
      request: parsed.request,
      requestDigest: parsed.requestDigest,
      scopeDigest: parsed.requestDigest,
    };
  } catch (error) {
    if (typeof error.terminal === 'boolean') throw error;
    throw evidenceError('INVALID_PACKAGE');
  }
}
async function submission(bounty, submissionRecord, fetcher = fetchCid) {
  const buffer = await fetcher(submissionRecord.hunterCid);
  try {
    const submissionArchive = archive(buffer);
    if (!validateArchiveShape(buffer).ok)
      throw evidenceError('INVALID_PACKAGE');
    const manifest = submissionArchive.json('manifest.json');
    const primary = submissionArchive.json(manifest.primary.filename);
    if (bounty.evidence.kind === 'custom') {
      if (typeof primary.query !== 'string' || !primary.query.trim())
        throw evidenceError('INVALID_PACKAGE');
      return true;
    }
    const references = (manifest.additional || []).filter(
      (reference) =>
        reference.filename && primary.references?.includes(reference.name),
    );
    const find = (filename) => {
      const matches = references.filter(
        (reference) => reference.filename.split('/').pop() === filename,
      );
      if (matches.length !== 1) throw evidenceError('INVALID_PACKAGE');
      return submissionArchive.text(matches[0].filename);
    };
    const result = JSON.parse(find('result.json'));
    if (!find('evidence.md').trim()) throw evidenceError('INVALID_PACKAGE');
    if (bounty.evidence.templateId === 'real-world-task-v1') {
      if (!Array.isArray(result.evidence))
        throw evidenceError('INVALID_PACKAGE');
      for (const item of result.evidence) {
        if (
          typeof item.filename !== 'string' ||
          !item.filename ||
          /[/\\]/.test(item.filename) ||
          !find(item.filename).length
        )
          throw evidenceError('INVALID_PACKAGE');
      }
    }
    const shared = await modules();
    if (
      shared.validateResult(
        bounty.evidence.templateId,
        bounty.evidence.request,
        result,
        bounty.evidence.requestDigest,
        { production: true },
      ).length
    )
      throw evidenceError('INVALID_PACKAGE');
    return true;
  } catch (error) {
    if (typeof error.terminal === 'boolean') throw error;
    throw evidenceError('INVALID_PACKAGE');
  }
}
module.exports = {
  inspectBounty,
  submission,
  templateDigests,
  archive,
  fetchCid,
};
