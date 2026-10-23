/**
 * Verifies a wager bounty's evaluation package: the ZIP at its on-chain evaluationCid that the
 * jury actually runs (manifest.json + primary_query.json, archiveGenerator.createEvaluationCIDArchive).
 * The site record shows the description and rubric, but the jury reads the package's query, outcomes,
 * references and jury parameters; a bounty created straight on the escrow can show canonical terms
 * while its package says something else. A counter's package is therefore rebuilt from its terms
 * (shared/mutualWager.js canonicalWagerText) and compared, part by part, with the one on chain.
 *
 * The rubric is the one the package itself attaches: fetched here at the gradingRubric CID its manifest
 * names, never taken from a site record or a loader fallback, and compared with the template. The verdict
 * carries that rubric (and the manifest's jury) so callers check exactly what the jury will read.
 *
 * Results are cached by package CID, description and verifier version: a CID names immutable bytes, and
 * the attachment is fetched by the CID inside them. A package or attachment that cannot be fetched right
 * now throws, so callers fail closed (503 / unknown state) and nothing is cached.
 */
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const wager = require('../../shared/mutualWager');
const { evaluationPackageFiles } = require('./archiveGenerator');

// 2: the rubric is fetched from the package's own attachment (version 1 trusted the caller's copy).
const VERIFIER_VERSION = 2;
const CACHE_MAX = 500;
const cache = new Map();

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keysAre = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && sameJson(Object.keys(o).sort(), [...keys].sort());

/**
 * { ok, problems: [message], verifier, rubricCid?, rubric?, juryNodes?, iterations? } for the package at
 * `evaluationCid`, against the wager terms in `description`. rubric is the content of the attachment the
 * package names (rubricCid), juryNodes / iterations the manifest's jury. Messages read after
 * "its evaluation package ". Throws when the package or its rubric attachment cannot be read now.
 */
async function verifyWagerPackage({ evaluationCid, description, ipfsClient }) {
  const key = `${VERIFIER_VERSION}:${evaluationCid}:${crypto.createHash('sha256').update(String(description || '')).digest('hex')}`;
  if (cache.has(key)) return cache.get(key);

  const problems = [];
  const found = {};   // what the package itself names: rubricCid, rubric, juryNodes, iterations
  const done = () => {
    const result = { ok: problems.length === 0, problems, verifier: VERIFIER_VERSION, ...found };
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

  // The jury the manifest actually names, for the counter check (it compares juries with the caller's).
  const aiNodes = manifest?.juryParameters?.AI_NODES;
  if (Array.isArray(aiNodes)) {
    found.juryNodes = aiNodes.filter((n) => n && typeof n === 'object').map((n) => ({ provider: n.AI_PROVIDER, model: n.AI_MODEL, runs: n.NO_COUNTS, weight: n.WEIGHT }));
    found.iterations = manifest.juryParameters.ITERATIONS;
  }

  // The rubric the jury receives is the attachment this package names: fetch it by that CID (throws when it
  // cannot be read now; a readable copy elsewhere is no substitute) and compare it with the template.
  const add = manifest?.additional;
  const rubricCid = Array.isArray(add) && add.length === 1 && add[0] && add[0].name === 'gradingRubric' && typeof add[0].hash === 'string' ? add[0].hash : null;
  if (!rubricCid) { problems.push('does not attach exactly one grading rubric'); return done(); }
  found.rubricCid = rubricCid;
  const rubricBuffer = await ipfsClient.fetchFromIPFS(rubricCid);   // throws: caller fails closed
  let rubric;
  try { rubric = JSON.parse(Buffer.isBuffer(rubricBuffer) ? rubricBuffer.toString('utf8') : String(rubricBuffer)); }
  catch { problems.push(`attaches a rubric (${rubricCid}) that is not JSON`); return done(); }
  found.rubric = rubric;
  // Compared with the template the terms name (mutual-wager-v3, -v4 or -v5).
  const edited = wager.mutualWagerRubricProblem(rubric, wager.wagerSpec(t).template);
  if (edited) problems.push(`attaches a rubric (${rubricCid}) that ${edited.detail}`);

  // What this site would have built from the bounty's terms (the same function createEvaluationCIDArchive
  // uses), with the attached rubric.
  const text = wager.canonicalWagerText(t);
  const jury = wager.parseJuryLine(t.fields.jury);
  if (!jury) { problems.push('cannot be rebuilt: its Jury line cannot be read'); return done(); }
  if (!Array.isArray(rubric.criteria)) { problems.push('attaches a rubric with no criteria'); return done(); }
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
