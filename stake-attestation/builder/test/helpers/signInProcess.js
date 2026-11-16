// The builder's `sign`, as the sign job runs it, for a test that runs it in a process of its own (with
// test/helpers/trustStub.cjs loaded). Only the project's proof is doubled: its check reads a git host.
import { main } from '../../src/cli.js';
import { provenAnswer } from './proof.js';

process.exitCode = await main(process.argv.slice(2), { env: process.env, stdout: process.stdout, stderr: process.stderr, deps: { checkRepositoryControl: provenAnswer() } });
