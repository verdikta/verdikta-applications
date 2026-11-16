import fs from 'node:fs';

/** The builder's own version (package.json). */
export const BUILDER_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
