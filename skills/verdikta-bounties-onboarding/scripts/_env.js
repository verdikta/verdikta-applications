// Loads environment variables from scripts/.env (if present) for local dev convenience.
// Only loads from the scripts directory (next to this file) to prevent accidentally
// picking up unrelated .env files from the caller's working directory.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '.env');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}
