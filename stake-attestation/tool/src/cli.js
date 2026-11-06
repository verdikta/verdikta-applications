import fs from 'node:fs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// The hunter's commands (design §7.2, hunter-tool row; built in P5).
export const COMMANDS = {
  check: 'Run the arbiters\' pipeline minus the jury on a claim, locally',
  commit: 'Encrypt a claim to the maker\'s disclosure key, pin it and commit on-chain',
  reveal: 'Pin the plaintext claim and reveal it once it is revealable',
  status: 'Show a claim\'s state and its pending evaluation',
  claim: 'Finalize, settle and withdraw a claim\'s payout',
};

const USAGE = `Usage: verdikta-attest <command> [options]

Hunter tool for Verdikta stake attestation: prove a bug in a staked version of
someone's code with a runnable test, disclose it to the maker first, and have the
Verdikta arbiters judge it after the fix window.

Commands (not available in this release):
${Object.entries(COMMANDS).map(([name, about]) => `  ${name.padEnd(8)}${about}`).join('\n')}

Options:
  -h, --help     Show this help
  -v, --version  Print the version
`;

/**
 * Runs the CLI and returns its exit code: 0 on success, 2 on a usage error or a command this
 * release does not have.
 * @param {string[]} argv arguments after the program name
 * @param {{ stdout: { write(s: string): unknown }, stderr: { write(s: string): unknown } }} io
 */
export function run(argv, { stdout, stderr } = process) {
  const [first] = argv;
  if (first === '-h' || first === '--help') {
    stdout.write(USAGE);
    return 0;
  }
  if (first === '-v' || first === '--version') {
    stdout.write(`${version}\n`);
    return 0;
  }
  if (first === undefined) {
    stderr.write(USAGE);
    return 2;
  }
  if (first.startsWith('-')) {
    stderr.write(`verdikta-attest: unknown option '${first}'\n\n${USAGE}`);
    return 2;
  }
  if (Object.hasOwn(COMMANDS, first)) {
    stderr.write(`verdikta-attest: '${first}' is not available in this release\n`);
    return 2;
  }
  stderr.write(`verdikta-attest: unknown command '${first}'\n\n${USAGE}`);
  return 2;
}
