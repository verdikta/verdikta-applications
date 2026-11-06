// `npm run abi`: rewrites src/abi/StakeAttestation.json, the merged ABI the tool runs with, from the
// contracts in ../onchain (compiled on the in-process network). One fragment per line, as the server's.
// test/abi.test.js fails until the committed file matches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hardhat, mergedAbi } from './chain.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'abi', 'StakeAttestation.json');
const abi = mergedAbi(await hardhat());
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `[\n${abi.map((f) => `  ${JSON.stringify(f)}`).join(',\n')}\n]\n`);
console.log(`wrote ${abi.length} fragments to ${path.relative(process.cwd(), out)}`);
