#!/usr/bin/env node
// Fails (exit 1) when any given file, or any file under a given directory, holds a banned word.
// Usage: check-forbidden-words <path>...   Exit 2 on a usage error or a missing path.
import fs from 'node:fs';

import { scanPaths } from '../src/scan.js';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  process.stderr.write('Usage: check-forbidden-words <path>...\n');
  process.exit(2);
}
const missing = paths.filter((p) => !fs.existsSync(p));
if (missing.length > 0) {
  process.stderr.write(`check-forbidden-words: no such path: ${missing.join(', ')}\n`);
  process.exit(2);
}

const { filesScanned, hits } = scanPaths(paths);
if (hits.length > 0) {
  for (const { file, line, column } of hits) {
    process.stderr.write(`${file}:${line}:${column}: banned word (see stake-attestation/README.md, "Wording rule")\n`);
  }
  process.stderr.write(`check-forbidden-words: ${hits.length} banned word(s) in ${filesScanned} files\n`);
  process.exit(1);
}
process.stdout.write(`check-forbidden-words: no banned words in ${filesScanned} files\n`);
