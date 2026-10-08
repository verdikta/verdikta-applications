'use strict';
const AdmZip = require('adm-zip');
const { fetchArchiveBuffer, validateArchiveShape } = require('../utils/archiveShapeValidator');
const { buildEvaluationQuery } = require('../utils/archiveGenerator');
const { digest } = require('./config');
const CID = /^[a-zA-Z0-9]{46,100}$/;
// Only fixed gateways through the existing bounded fetcher; no URL from claim/request text is fetched.
async function fetchCid(cid) {
  if (!CID.test(cid)) throw new Error('INVALID_CID');
  return fetchArchiveBuffer(cid, { maxBytes: 4 * 1024 * 1024, totalTimeoutMs: 10000 });
}
function archive(buffer) {
  if (buffer.length > 4 * 1024 * 1024) throw new Error('ARCHIVE_TOO_LARGE');
  const zip = new AdmZip(buffer), entries = zip.getEntries();
  if (entries.length > 100 || new Set(entries.map(e => e.entryName)).size !== entries.length
    || entries.reduce((n,e) => n + e.header.size, 0) > 8 * 1024 * 1024) throw new Error('ARCHIVE_BOUNDS');
  const text = name => {
    const e = zip.getEntry(name);
    if (!e || e.header.size > 1024 * 1024 || e.isDirectory) throw new Error('MISSING_OR_OVERSIZE_ENTRY');
    return e.getData().toString('utf8');
  };
  return { text, json: name => JSON.parse(text(name)) };
}
async function modules() {
  const [wo, core, validation] = await Promise.all([
    import('../../../skills/verdikta-discover/scripts/work-order.mjs'),
    import('../../../skills/verdikta-discover/scripts/preview-core.mjs'),
    import('../../../skills/verdikta-discover/scripts/validation.mjs')
  ]);
  return { ...wo, ...core, ...validation };
}
async function templateDigests() {
  const m = await modules();
  const fs = require('fs'), path = require('path');
  return Object.keys(m.templates).map(id => ({ id, sha256: digest({ template: m.templates[id], rubric: JSON.parse(fs.readFileSync(path.join(__dirname, '../../../skills/verdikta-discover/templates', `${id}.rubric.json`), 'utf8')) }) }));
}
async function workOrder(b, config, fetcher = fetchCid) {
  const m = await modules();
  const a = archive(await fetcher(b.evaluationCid)), manifest = a.json('manifest.json');
  const primary = a.json(manifest.primary?.filename);
  if (!m.sameJson(primary.outcomes, ['DONT_FUND','FUND']) || !m.sameJson(primary.references, ['gradingRubric'])) throw new Error('EVALUATION_SHAPE');
  const match = primary.query?.match(/^WORK PRODUCT EVALUATION REQUEST[\s\S]*?=== TASK DESCRIPTION ===\nWork Product Type: ([^\n]+)\nTask Title: ([^\n]+)\nTask Description: ([\s\S]*?)\n\n=== EVALUATION PROTOCOL ===/);
  if (!match) throw new Error('UNSUPPORTED_EVALUATION_QUERY');
  if (['Service: ', 'Request bytes SHA-256 (result.input_sha256): ', 'Approved work-order draft SHA-256: ', 'Request (exact UTF-8 JSON bytes, no trailing newline):'].some(prefix => match[3].split('\n').filter(l => l.startsWith(prefix)).length !== 1)) throw new Error('AMBIGUOUS_WORK_ORDER');
  const parsed = m.parseWorkOrderDescription(match[3]);
  if (!parsed || parsed.errors.length || parsed.request.fixture_only) throw new Error('WORK_ORDER_HASH');
  const derived = m.preview({ request: parsed.request, template_id: parsed.templateId, sharing_authorized: true, procurement_mode: 'OPEN' });
  if (!derived.draft || m.validateRequest(parsed.templateId, parsed.request).length) throw new Error('WORK_ORDER_REQUEST');
  const approved = (await templateDigests()).find(t => t.id === parsed.templateId);
  if (!config.approvedTemplates.some(t => t.id === approved?.id && t.sha256 === approved.sha256)) throw new Error('TEMPLATE_VERSION_NOT_APPROVED');
  const refs = manifest.additional?.filter(x => x.name === 'gradingRubric');
  if (refs?.length !== 1 || refs[0].type !== 'ipfs/cid') throw new Error('RUBRIC_REFERENCE');
  const raw = await fetcher(refs[0].hash);
  const rubric = JSON.parse(raw.toString('utf8'));
  const criteria = list => list?.map(c => ({ id:c.id, label:c.label, must:!!c.must, weight:Number(c.weight), description:c.description ?? c.instructions }));
  if (rubric.title !== derived.draft.rubric.title || !m.sameJson(criteria(rubric.criteria), criteria(derived.draft.rubric.criteria))
    || !m.sameJson(rubric.forbiddenContent ?? rubric.forbidden_content ?? [], derived.draft.rubric.forbidden_content ?? [])
    || b.threshold !== derived.draft.threshold) throw new Error('RUBRIC_CHANGED');
  const rebuilt = buildEvaluationQuery({ workProductType:match[1], jobTitle:match[2], jobDescription:match[3], rubricCriteria:rubric.criteria, forbiddenContent:rubric.forbiddenContent ?? rubric.forbidden_content });
  if (rebuilt !== primary.query) throw new Error('EVALUATION_QUERY_CHANGED');
  return { ok:true, templateId:parsed.templateId, requestDigest:parsed.requestDigest, request:parsed.request,
    evaluationCid:b.evaluationCid, rubricCid:refs[0].hash, templateSha256:approved.sha256 };
}
async function submission(b, s, fetcher = fetchCid) {
  const m = await modules(), buf = await fetcher(s.hunterCid);
  const a = archive(buf);
  if (!validateArchiveShape(buf).ok) return false;
  const manifest = a.json('manifest.json'), primary = a.json(manifest.primary.filename);
  const find = file => {
    const candidates = (manifest.additional || []).filter(r => r.filename?.split('/').pop() === file && primary.references?.includes(r.name));
    if (candidates.length !== 1) throw new Error('REQUIRED_WORK_MISSING');
    return a.text(candidates[0].filename);
  };
  const result = JSON.parse(find('result.json'));
  if (!find('evidence.md').trim()) return false;
  // A structurally declared photo/file is not a delivered attachment. Never fetch its URL.
  if (b.workOrder.templateId === 'real-world-task-v1') {
    if (!Array.isArray(result.evidence)) return false;
    for (const e of result.evidence) {
      if (typeof e.filename !== 'string' || !e.filename || e.filename.includes('/') || e.filename.includes('\\') || !find(e.filename).length) return false;
    }
  }
  return m.validateResult(b.workOrder.templateId, b.workOrder.request, result, b.workOrder.requestDigest, { production:true }).length === 0;
}
module.exports = { workOrder, submission, templateDigests, archive };
