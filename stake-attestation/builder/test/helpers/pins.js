// The arbiter commit this app runs against, as the files that pin it name it. Three files, one commit:
// the reusable workflow's runner, P3a's Docker tests and the local round. Read from the files, so
// the rule holds whatever they are moved to.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const REPO_DIR = path.resolve(APP_DIR, '..');

const readJson = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

/** Each pin file and what it names. @param {string} [root] - stake-attestation/ */
export function readArbiterPins(root = APP_DIR) {
  return [
    { file: 'builder/action/pins.json', ...readJson(root, 'builder/action/pins.json').codeRunner },
    { file: 'builder/test/docker/code-runner.pin.json', ...readJson(root, 'builder/test/docker/code-runner.pin.json') },
    { file: 'e2e/arbiter.pin.json', ...readJson(root, 'e2e/arbiter.pin.json') },
  ];
}

/** What is wrong with a set of pins, in words: nothing when they name one commit of one repository. */
export function pinProblems(pins) {
  const problems = [];
  const distinct = (key) => [...new Set(pins.map((p) => p[key]).filter((v) => v !== undefined))];
  if (pins.length < 2) problems.push(`${pins.length} pin file(s) read`);
  for (const p of pins) {
    if (!/^[0-9a-f]{40}$/.test(String(p.commit))) problems.push(`${p.file} names ${JSON.stringify(p.commit)}, not a whole commit`);
  }
  if (distinct('commit').length !== 1) problems.push(`the commits differ: ${pins.map((p) => `${p.file} ${p.commit}`).join(', ')}`);
  if (distinct('repository').length !== 1) problems.push(`the repositories differ: ${pins.map((p) => `${p.file} ${p.repository}`).join(', ')}`);
  if (distinct('branch').length > 1) problems.push(`the branches differ: ${pins.map((p) => `${p.file} ${p.branch}`).join(', ')}`);
  return problems;
}

const SKIP = new Set(['node_modules', '.arbiter', '.round', 'dist', 'artifacts', 'cache', 'coverage', 'test-results', 'playwright-report', 'typechain-types', '.git']);
const TEXT = /\.(?:js|mjs|cjs|jsx|ts|json|ya?ml|md|sh|toml|txt)$/;
const NAMES_A_COMMIT = /verdikta-arbiter[^\n]{0,160}\b[0-9a-f]{40}\b|\b[0-9a-f]{40}\b[^\n]{0,160}verdikta-arbiter/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && TEXT.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * A fourth place that pins the arbiter: a JSON file naming its repository with a commit, a line naming
 * it beside a whole commit id, or a workflow that checks it out at a ref of its own.
 * @returns {string[]} files, relative to `repoDir`
 */
export function otherArbiterPins({ appDir = APP_DIR, repoDir = REPO_DIR } = {}) {
  const known = new Set(readArbiterPins(appDir).map((p) => path.join(appDir, p.file)));
  const found = [];
  for (const file of [...walk(appDir), ...walk(path.join(repoDir, '.github', 'workflows'))]) {
    if (known.has(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (NAMES_A_COMMIT.test(text) || /repository:\s*['"]?verdikta\/verdikta-arbiter/.test(text)) found.push(path.relative(repoDir, file));
    else if (file.endsWith('.json') && /verdikta-arbiter/.test(text) && /"commit"\s*:/.test(text)) found.push(path.relative(repoDir, file));
  }
  return found;
}
