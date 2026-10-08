'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const {
  fetchArchiveBuffer,
  validateArchiveShape,
} = require('../utils/archiveShapeValidator');
const { buildEvaluationQuery } = require('../utils/archiveGenerator');
const { sha256, digest, canonicalRubric, snapshotDigest } = require('./config');
const { evidenceError, isEvidenceError } = require('./cache');
function evidenceFingerprint() {
  const skillRoot = path.join(__dirname, '../../../skills/verdikta-discover');
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(skillRoot, 'package.json'), 'utf8'),
  ).version;
  const templateVersions = fs
    .readdirSync(path.join(skillRoot, 'templates'))
    .filter((filename) => filename.endsWith('.template.json'))
    .sort()
    .map((filename) => [
      filename,
      JSON.parse(
        fs.readFileSync(path.join(skillRoot, 'templates', filename), 'utf8'),
      ).template_version,
    ]);
  return digest({
    generatorSource: fs.readFileSync(
      path.join(__dirname, '../utils/archiveGenerator.js'),
      'utf8',
    ),
    packageVersion,
    templateVersions,
  });
}
function packageJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw evidenceError('INVALID_PACKAGE');
    throw error;
  }
}
function checkedErrors(errors) {
  if (!Array.isArray(errors))
    throw new Error('Unexpected shared validator result');
  return errors;
}
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
      if (typeof filename !== 'string' || !filename)
        throw evidenceError('INVALID_PACKAGE');
      const entry = zip.getEntry(filename);
      if (!entry || entry.header.size > 1024 * 1024 || entry.isDirectory)
        throw evidenceError('INVALID_PACKAGE');
      try {
        return entry.getData();
      } catch {
        throw evidenceError('INVALID_PACKAGE');
      }
    };
    return {
      bytes,
      text: (filename) => bytes(filename).toString('utf8'),
      json: (filename) => packageJson(bytes(filename).toString('utf8')),
    };
  } catch {
    throw evidenceError('INVALID_PACKAGE');
  }
}
async function loadModules() {
  const [workOrder, core, validation] = await Promise.all([
    import('../../../skills/verdikta-discover/scripts/work-order.mjs'),
    import('../../../skills/verdikta-discover/scripts/preview-core.mjs'),
    import('../../../skills/verdikta-discover/scripts/validation.mjs'),
  ]);
  return { ...workOrder, ...core, ...validation };
}
async function templateDigests() {
  const shared = await loadModules();
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
async function inspectBounty(
  bounty,
  config,
  fetcher = fetchCid,
  moduleLoader = loadModules,
) {
  try {
    const evaluationBytes = await fetcher(bounty.evaluationCid);
    const evaluationArchive = archive(evaluationBytes);
    const manifest = evaluationArchive.json('manifest.json');
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
      throw evidenceError('INVALID_PACKAGE');
    const primary = evaluationArchive.json(manifest.primary?.filename);
    if (!primary || typeof primary.query !== 'string' || !primary.query.trim())
      throw evidenceError('INVALID_PACKAGE');
    if (
      !Array.isArray(manifest.additional) ||
      manifest.additional.some(
        (reference) => !reference || typeof reference !== 'object',
      )
    )
      throw evidenceError('INVALID_PACKAGE');
    const references = manifest.additional.filter(
      (reference) => reference.name === 'gradingRubric',
    );
    if (
      references.length !== 1 ||
      references[0].type !== 'ipfs/cid' ||
      typeof references[0].hash !== 'string'
    )
      throw evidenceError('INVALID_PACKAGE');
    const rubric = packageJson(
      (await fetcher(references[0].hash)).toString('utf8'),
    );
    if (
      !rubric ||
      !Array.isArray(rubric.criteria) ||
      !rubric.criteria.length ||
      rubric.criteria.some(
        (criterion) =>
          !criterion ||
          typeof criterion !== 'object' ||
          Array.isArray(criterion),
      )
    )
      throw evidenceError('INVALID_PACKAGE');
    const common = {
      ok: true,
      evaluationCid: bounty.evaluationCid,
      rubricCid: references[0].hash,
    };
    const custom = (classification) => ({
      ...common,
      kind: 'custom',
      scopeDigest: sha256(primary.query),
      classification,
    });
    const shared = await moduleLoader();
    const parsed = shared.parseWorkOrderDescription(primary.query);
    if (parsed === null) return custom('NOT_A_WORK_ORDER');
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.templateId !== 'string' ||
      typeof parsed.requestDigest !== 'string' ||
      !Object.hasOwn(parsed, 'request')
    )
      throw new Error('Unexpected shared parser result');
    checkedErrors(parsed.errors);
    // Prove the query is intact against its own fetched rubric before any XP fallback.
    const match = primary.query.match(
      /^WORK PRODUCT EVALUATION REQUEST[\s\S]*?=== TASK DESCRIPTION ===\nWork Product Type: ([^\n]+)\nTask Title: ([^\n]+)\nTask Description: ([\s\S]*?)\n\n=== EVALUATION PROTOCOL ===/,
    );
    if (!match) throw evidenceError('EVALUATION_QUERY_CHANGED');
    const forbiddenContent =
      rubric.forbiddenContent ?? rubric.forbidden_content;
    if (
      (forbiddenContent !== undefined && !Array.isArray(forbiddenContent)) ||
      rubric.criteria.some(
        (criterion) =>
          criterion.weight !== undefined &&
          typeof criterion.weight !== 'number',
      )
    )
      throw evidenceError('INVALID_PACKAGE');
    const rebuilt = buildEvaluationQuery({
      workProductType: match[1],
      jobTitle: match[2],
      jobDescription: match[3],
      rubricCriteria: rubric.criteria,
      forbiddenContent,
    });
    if (typeof rebuilt !== 'string')
      throw new Error('Unexpected query builder result');
    if (rebuilt !== primary.query)
      throw evidenceError('EVALUATION_QUERY_CHANGED');
    if (
      JSON.stringify(primary.outcomes) !==
        JSON.stringify(['DONT_FUND', 'FUND']) ||
      JSON.stringify(primary.references) !== JSON.stringify(['gradingRubric'])
    )
      throw evidenceError('INVALID_PACKAGE');
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
      return custom('AMBIGUOUS_WORK_ORDER');
    if (
      parsed.errors.length ||
      parsed.request?.fixture_only ||
      checkedErrors(shared.validateRequest(parsed.templateId, parsed.request))
        .length
    )
      return custom('WORK_ORDER_HASH_OR_REQUEST_INVALID');
    const snapshot = config.approvedTemplates.find((candidate) => {
      if (
        candidate.id !== parsed.templateId ||
        bounty.threshold !== candidate.threshold
      )
        return false;
      const same = shared.sameJson(
        canonicalRubric(rubric),
        canonicalRubric(candidate.rubric),
      );
      if (typeof same !== 'boolean')
        throw new Error('Unexpected rubric comparison result');
      return same;
    });
    if (!snapshot) return custom('RUBRIC_MISMATCH');
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
    if (isEvidenceError(error)) throw error;
    throw evidenceError(
      'EVIDENCE_CHECK_FAILED_RETRY',
      false,
      bounty.evaluationCid,
    );
  }
}
async function submission(
  bounty,
  submissionRecord,
  fetcher = fetchCid,
  moduleLoader = loadModules,
) {
  try {
    const buffer = await fetcher(submissionRecord.hunterCid);
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
    if (
      !Array.isArray(manifest.additional) ||
      !Array.isArray(primary.references) ||
      manifest.additional.some(
        (reference) =>
          !reference ||
          typeof reference !== 'object' ||
          (reference.filename !== undefined &&
            typeof reference.filename !== 'string'),
      )
    )
      throw evidenceError('INVALID_PACKAGE');
    const references = manifest.additional.filter(
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
    const result = packageJson(find('result.json'));
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw evidenceError('INVALID_PACKAGE');
    if (!find('evidence.md').trim()) throw evidenceError('INVALID_PACKAGE');
    if (bounty.evidence.templateId === 'real-world-task-v1') {
      if (!Array.isArray(result.evidence))
        throw evidenceError('INVALID_PACKAGE');
      for (const item of result.evidence) {
        if (
          !item ||
          typeof item.filename !== 'string' ||
          !item.filename ||
          /[/\\]/.test(item.filename) ||
          !find(item.filename).length
        )
          throw evidenceError('INVALID_PACKAGE');
      }
    }
    const shared = await moduleLoader();
    if (
      checkedErrors(
        shared.validateResult(
          bounty.evidence.templateId,
          bounty.evidence.request,
          result,
          bounty.evidence.requestDigest,
          { production: true },
        ),
      ).length
    )
      throw evidenceError('INVALID_PACKAGE');
    return true;
  } catch (error) {
    if (isEvidenceError(error)) throw error;
    throw evidenceError(
      'EVIDENCE_CHECK_FAILED_RETRY',
      false,
      submissionRecord.hunterCid,
    );
  }
}
module.exports = {
  inspectBounty,
  loadModules,
  evidenceFingerprint,
  isEvidenceError,
  submission,
  templateDigests,
  archive,
  fetchCid,
};
