// The listing's documents (stake.documents; owner decision Q61 (a); node P20): which files of the listed commit the
// arbiters' runner would put in the jurors' context pack, and what it would leave out. They are chosen as the runner
// chooses them, by @verdikta/common's selectDocuments over the listed commit's own entries (`git ls-tree -r` at
// baseCommit, read from the objects the builder fetched by commit id, never from a work tree, which a maker's setup
// could change), with no affected paths, since a listing has no claim yet. A file counts when common's rules say it
// does (a regular file of at most maxFileBytes whose bytes are text by isDocumentText). This file holds no glob rule
// and no copy of the selection: what it adds is the account the maker reads in the validation report.
//
// A listing whose globs cost more than common's step meter allows (DOCUMENTS_MATCH_TOO_COSTLY) is refused at the
// documents step, right after the fetch and before anything is built, so it never stalls the arbiters on its claims;
// `sign` runs the same selection again over a fresh fetch of the commit (recheckDocuments) and refuses it the same
// way, and signs only a report that records what the selection gives. A glob that matches no file is a warning.
// Nothing here runs for a listing that names no documents, and its report has no documents step or section.
import fs from 'node:fs';
import path from 'node:path';

import { STAKE_DOCUMENTS_PATH, documentGlobs } from '@verdikta/stake-attestation-shared/stake-documents';

import { listedEntries, readBlobs } from './commitFiles.js';
import { codeReview } from './common.js';
import { BuilderError, Refusal } from './errors.js';
import { fetchListedCommit as fetchDefault } from './git.js';

const { STAKE_DOCUMENT_LIMITS } = codeReview;
const FETCH_TIMEOUT_MS = 600000;
const GIT_TIMEOUT_MS = 120000;
const REGULAR = new Set(['100644', '100755']);

/** A path the runner can ask `git cat-file --batch` for: one line, no NUL (code-runner/src/pack.js, askablePath). */
const askable = (p) => p !== '' && !/[\r\n\0]/.test(p);

/**
 * common's selection over the candidates, with the refusals a listing gets for it.
 * @throws {Refusal} DOCUMENTS_MATCH_TOO_COSTLY, or STAKE_DOCUMENTS_INVALID for any other error of the selection
 */
function select(paths, stake) {
  const refuse = (code, detail) => Object.assign(new Refusal(code, detail), { all: [{ code, detail, path: STAKE_DOCUMENTS_PATH }] });
  try {
    return codeReview.selectDocuments(paths, stake, []);
  } catch (err) {
    if (err?.code === 'DOCUMENTS_MATCH_TOO_COSTLY') throw refuse(err.code, `${err.message}: the arbiters would refuse every claim on this listing`);
    throw refuse('STAKE_DOCUMENTS_INVALID', `stake.documents could not be matched against the listed commit's files (${err?.name ?? 'an error'} from @verdikta/common)`);
  }
}

/**
 * Whether a glob matches a file of its own, by common's selection of that glob alone. A glob whose match alone is past
 * the meter is not called unmatched: the whole selection was within it, so the glob took files or was spared the work.
 */
function matchesSomething(paths, stake, glob) {
  try {
    const one = codeReview.selectDocuments(paths, { ...stake, documents: [glob] }, []);
    return one.paths.length + one.pastCap.length + one.inSource.length > 0;
  } catch {
    return true;
  }
}

/**
 * The documents step's account of a listing that names documents.
 * @param {{ gitDir: string, spec: object, timeoutMs?: number }} o - the fetched objects; the draft or the built spec
 * @returns {Promise<{ record: object, warnings: object[] }>} report.documents, and a warning per glob that matches nothing
 * @throws {Refusal} DOCUMENTS_MATCH_TOO_COSTLY, STAKE_DOCUMENTS_INVALID
 * @throws {BuilderError} SOURCE_READ_FAILED
 */
export async function chooseDocuments({ gitDir, spec, timeoutMs = GIT_TIMEOUT_MS }) {
  const globs = documentGlobs(spec);
  const entries = await listedEntries({ gitDir, commit: spec.baseCommit, timeoutMs });
  // the candidates: the listed commit's own paths in their one UTF-8 spelling, as the runner takes them
  const byName = new Map(entries.filter((e) => e.path !== null).map((e) => [e.path, e]));
  const paths = [...byName.keys()];
  const selection = select(paths, spec.stake);

  const skipped = [];
  const ask = [];
  for (const p of selection.paths) {
    const e = byName.get(p);
    if (e.mode === '120000') skipped.push({ path: p, reason: 'symlink' });
    else if (e.type === 'commit') skipped.push({ path: p, reason: 'submodule' });
    else if (e.type !== 'blob' || !REGULAR.has(e.mode)) skipped.push({ path: p, reason: 'notAFile' });
    else if (!(e.size <= STAKE_DOCUMENT_LIMITS.maxFileBytes)) skipped.push({ path: p, reason: 'tooLarge', bytes: e.size });
    else if (!askable(p)) skipped.push({ path: p, reason: 'notAskable' });
    else ask.push(e);
  }
  const contents = await readBlobs(gitDir, [...new Set(ask.map((e) => e.id))], timeoutMs);
  const text = new Set();
  for (const e of ask) {
    if (codeReview.isDocumentText(contents.get(e.id))) text.add(e.path);
    else skipped.push({ path: e.path, reason: 'notText', bytes: e.size });
  }
  // both in the selection's order: the order the tier reads them in
  const rank = new Map(selection.paths.map((p, i) => [p, i]));
  skipped.sort((a, b) => rank.get(a.path) - rank.get(b.path));
  const read = selection.paths.filter((p) => text.has(p)).map((p) => ({ path: p, bytes: byName.get(p).size }));

  const unmatched = [];
  globs.forEach((glob, index) => {
    if (!matchesSomething(paths, spec.stake, glob)) unmatched.push({ index, glob });
  });
  const warnings = unmatched.map(({ index, glob }) => ({
    code: 'STAKE_DOCUMENT_MATCHES_NOTHING',
    path: `${STAKE_DOCUMENTS_PATH}/${index}`,
    detail: `${JSON.stringify(glob)} matches no file of the listed commit, so the jurors read nothing for it; check its spelling (paths are as git lists them, and case counts)`,
  }));
  return {
    record: { globs, candidates: paths.length, read, pastCap: [...selection.pastCap], skipped, unmatched },
    warnings,
  };
}

/**
 * What `sign` repeats for a listing that names documents: the listed commit fetched again by id, common's selection
 * over its own entries again, and the report's account held to it. Nothing of the maker's runs here.
 * @param {{ spec: object, report: object, config: object, deps?: { fetchListedCommit?: Function } }} o
 * @throws {BuilderError} DOCUMENTS_MATCH_TOO_COSTLY, STAKE_DOCUMENTS_INVALID, SIGNING_REPORT_MISMATCH, or the fetch's
 */
export async function recheckDocuments({ spec, report, config, deps = {} }) {
  const fetchListedCommit = deps.fetchListedCommit ?? fetchDefault;
  const tmp = fs.mkdtempSync(path.join(config.workDir, 'vab-sign-documents-'));
  try {
    const gitDir = path.join(tmp, 'fetched.git');
    let chosen;
    try {
      await fetchListedCommit({ repo: spec.repo, baseCommit: spec.baseCommit, mirror: config.mirrorFor(spec.repo), dir: gitDir, timeoutMs: FETCH_TIMEOUT_MS });
      chosen = await chooseDocuments({ gitDir, spec });
    } catch (err) {
      if (err instanceof Refusal) throw new BuilderError(err.code, err.detail, { step: 'sign' });
      throw err;
    }
    if (JSON.stringify(chosen.record) !== JSON.stringify(report.documents)) {
      throw new BuilderError('SIGNING_REPORT_MISMATCH', 'the report\'s documents are not what common\'s selection over the listed commit gives', { step: 'sign' });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
