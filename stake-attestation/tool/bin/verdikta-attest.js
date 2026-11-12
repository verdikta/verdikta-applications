#!/usr/bin/env node
import { run } from '../src/cli.js';

// A failure outside the tool's own handling prints its kind only: its text could quote anything.
const bail = (err) => {
  process.stderr.write(`verdikta-attest: INTERNAL: ${err?.name ?? 'Error'}\n`, () => process.exit(1));
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

// An explicit exit, so a read that hung past its limit cannot hold the process open, but only once what was
// written has left: a pipe is asynchronous on some platforms, and an exit would cut a long answer short.
const code = await run(process.argv.slice(2), process, process.env);
process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
