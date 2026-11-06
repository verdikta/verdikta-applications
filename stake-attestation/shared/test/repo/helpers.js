import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// stake-attestation/ and the repository root.
export const APP_DIR = path.resolve(here, '..', '..', '..');
export const REPO_ROOT = path.resolve(APP_DIR, '..');

// The app's npm packages. A new package is added here and to the workflow together.
export const PACKAGES = ['onchain', 'server', 'client', 'tool', 'shared'];
