/**
 * Verifies a wager bounty's evaluation package: the ZIP at its on-chain evaluationCid that the
 * jury actually runs (manifest.json + primary_query.json, archiveGenerator.createEvaluationCIDArchive).
 * The site record shows the description and rubric, but the jury reads the package's query, outcomes,
 * references and jury parameters; a bounty created straight on the escrow can show canonical terms
 * while its package says something else. A counter's package is therefore rebuilt from its terms
 * (shared/mutualWager.js canonicalWagerText) and compared, part by part, with the one on chain.
 *
 * Results are cached by package CID, description and verifier version: a CID names immutable bytes.
 * A package that cannot be fetched right now throws, so callers fail closed (503 / unknown state).
 */
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const wager = require('../../shared/mutualWager');
const { evaluationPackageFiles } = require('./archiveGenerator');

const VERIFIER_VERSION = 1;
const CACHE_MAX = 500;
const cache = new Map();

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keysAre = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && sameJson(Object.keys(o).sort(), [...keys].sort());

/**
 * { ok, problems: [message], verifier } for the package at `evaluationCid`, against the wager terms in
 * `description` and the rubric the package's gradingRubric names (`rubric`). Messages read after
 * "its evaluation package ". Throws when the package cannot be read now.
 */
async function verifyWagerPackage({ evaluationCid, description, rubric, ipfsClient }) {
  const key = `${VERIFIER_VERSION}:${evaluationCid}:${crypto.createHash('sha256').update(String(description || '')).digest('hex')}`;
  if (cache.has(key)) return cache.get(key);

  const problems = [];
  const done = () => {
    const result = { ok: problems.length === 0, problems, verifier: VERIFIER_VERSION };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  };
  const t = wager.parseMutualWagerTerms(description);
  if (!t.found || !t.closed || t.count !== 1) { problems.push('cannot be rebuilt: its description has no single, complete terms block'); return done(); }
  if (!evaluationCid) { problems.push('is not named on chain'); return done(); }

  const buffer = await ipfsClient.fetchFromIPFS(evaluationCid);   // throws: caller fails closed
  let zip;
  try { zip = new AdmZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)); zip.getEntries(); }
  catch { problems.push('is not a ZIP archive'); return done(); }

  const files = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName).sort();
  if (!sameJson(files, ['manifest.json', 'primary_query.json'])) { problems.push(`holds ${files.join(', ') || 'no files'}, not exactly manifest.json and primary_query.json`); return done(); }
  let manifest, primary;
  try {
    manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
    primary = JSON.parse(zip.getEntry('primary_query.json').getData().toString('utf8'));
  } catch { problems.push('has a manifest or primary query that is not JSON'); return done(); }

  // What this site would have built from the bounty's terms (the same function createEvaluationCIDArchive
  // uses), naming the rubric the package attaches. The rubric itself is compared with the template elsewhere.
  const text = wager.canonicalWagerText(t);
  const jury = wager.parseJuryLine(t.fields.jury);
  const rubricCid = Array.isArray(manifest?.additional) ? manifest.additional[0]?.hash : undefined;
  if (!jury) { problems.push('cannot be rebuilt: its Jury line cannot be read'); return done(); }
  if (!rubric || !Array.isArray(rubric.criteria)) { problems.push('names a rubric that could not be compared'); return done(); }
  const expected = evaluationPackageFiles({
    rubricCid, jobTitle: text.title, jobDescription: text.description, workProductType: text.workProductType,
    juryNodes: jury.jury, iterations: jury.iterations,
    rubricCriteria: rubric.criteria, forbiddenContent: rubric.forbiddenContent || rubric.forbidden_content,
  });

  // manifest.json. The jury nodes may be listed in any order and the provider in any letter case.
  if (!keysAre(manifest, Object.keys(expected.manifest))) problems.push('has a manifest with fields this site does not write');
  else {
    for (const field of ['version', 'name', 'primary', 'additional', 'bCIDs']) {
      if (!sameJson(manifest[field], expected.manifest[field])) problems.push(`has a manifest "${field}" that is not the one this site builds from its terms`);
    }
    const nodeKey = (n) => (keysAre(n, ['AI_MODEL', 'AI_PROVIDER', 'NO_COUNTS', 'WEIGHT'])
      ? [String(n.AI_PROVIDER).toLowerCase(), n.AI_MODEL, Number(n.NO_COUNTS), Number(n.WEIGHT)].join(':') : null);
    const jp = manifest.juryParameters, want = expected.manifest.juryParameters;
    const nodes = (list) => (Array.isArray(list) ? list.map(nodeKey) : [null]);
    if (!keysAre(jp, Object.keys(want)) || jp.NUMBER_OF_OUTCOMES !== want.NUMBER_OF_OUTCOMES || jp.ITERATIONS !== want.ITERATIONS
      || nodes(jp.AI_NODES).includes(null) || !sameJson(nodes(jp.AI_NODES).sort(), nodes(want.AI_NODES).sort())) {
      problems.push('names a jury, iteration count or outcome count other than the ones in its terms');
    }
  }

  // primary_query.json: the query the jury runs, its references and its outcomes, exactly.
  if (!keysAre(primary, Object.keys(expected.primaryQuery))) problems.push('has a primary query with fields this site does not write');
  else {
    if (!sameJson(primary.references, expected.primaryQuery.references)) problems.push('references other files');
    if (!sameJson(primary.outcomes, expected.primaryQuery.outcomes)) problems.push(`has outcomes ${JSON.stringify(primary.outcomes)}, not ${JSON.stringify(expected.primaryQuery.outcomes)}`);
    if (primary.query !== expected.primaryQuery.query) problems.push('has a primary query (what the jury reads) that is not the one this site builds from its terms');
  }
  return done();
}

module.exports = { verifyWagerPackage, WAGER_PACKAGE_VERIFIER_VERSION: VERIFIER_VERSION, _cache: cache };
