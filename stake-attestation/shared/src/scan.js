import fs from 'node:fs';
import path from 'node:path';

import { findForbiddenWords } from './forbiddenWords.js';

// Dependencies are skipped everywhere; build and test output only where a package puts it,
// beside its package.json, so a source folder that happens to be called `cache` is still read.
// Lockfiles are generated, not ours to word.
export const IGNORED_DIRS = new Set(['.git', 'node_modules']);
export const GENERATED_DIRS = new Set([
  'dist',
  'build',
  'artifacts',
  'cache',
  'coverage',
  'typechain-types',
  'playwright-report',
  'test-results',
  'blob-report',
]);
export const IGNORED_FILES = new Set(['package-lock.json', 'coverage.json', 'gasReporterOutput.json']);

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Scans files and directories (recursively) for the banned words.
 * @param {string[]} paths files or directories; a missing path throws
 * @returns {{ filesScanned: number, hits: { file: string, word: string, line: number, column: number }[] }}
 */
export function scanPaths(paths) {
  const hits = [];
  let filesScanned = 0;

  const visit = (p) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      const packageRoot = fs.existsSync(path.join(p, 'package.json'));
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
        if (entry.isDirectory() && packageRoot && GENERATED_DIRS.has(entry.name)) continue;
        if (entry.isFile() && IGNORED_FILES.has(entry.name)) continue;
        if (entry.isDirectory() || entry.isFile()) visit(path.join(p, entry.name));
      }
      return;
    }
    const buffer = fs.readFileSync(p);
    if (isBinary(buffer)) return;
    filesScanned += 1;
    for (const { word, line, column } of findForbiddenWords(buffer.toString('utf8'))) {
      hits.push({ file: p, word, line, column });
    }
  };

  for (const p of paths) visit(p);
  return { filesScanned, hits };
}
