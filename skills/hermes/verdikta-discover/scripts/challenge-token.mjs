#!/usr/bin/env node
// Prints a challenge token for a real-world-task-v1 request: three groups of four characters from an alphabet with no
// look-alikes (no 0/O, 1/I/L, 5/S, 2/Z, 6/G, 8/B), so the token survives handwriting and being read back from a photograph.
// No arguments, no network, nothing written:  node scripts/challenge-token.mjs  ->  e.g. 7QKM-PX4T-9RHC
import { randomInt } from 'node:crypto';

// The same alphabet as CHALLENGE_TOKEN_ALPHABET in validation.mjs (tests/templates-1.1.test.mjs checks they agree); repeated
// here so this file runs on its own, without the skill's installed packages.
const ALPHABET = 'ACDEFHJKMNPQRTUVWXY3479';
const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
process.stdout.write(`${[group(), group(), group()].join('-')}\n`);
