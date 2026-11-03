// The hunter's commands, and the help text.
export const COMMANDS = {
  check: 'Run the arbiters\' pipeline minus the jury on a claim, locally',
  commit: 'Encrypt a claim to the maker\'s disclosure key, commit it on-chain, then pin and disclose it',
  reveal: 'Pin the plaintext claim and reveal it once it is revealable',
  status: 'Show a claim\'s state and its pending evaluation',
  claim: 'Finalize, settle and withdraw a claim\'s payout',
};

export const USAGE = `Usage: verdikta-attest <command> [options]

Hunter tool for Verdikta stake attestation: prove a bug in a staked version of
someone's code with a runnable test, disclose it to the maker first, and have the
Verdikta arbiters judge it after the fix window.

Commands:
${Object.entries(COMMANDS).map(([name, about]) => `  ${name.padEnd(8)}${about}`).join('\n')}

  check <claim-dir> (--listing <id> | --listing-archive <file>) [--no-pack] [--remote-runner]
                     --no-pack prints status and codes only: no pack, and nothing else that can quote the proof
  commit <claim-dir> --listing <id> [--yes] [--restart] [--accept-unread-pin]
  reveal <claim-dir> [--retrigger]
  status <claim-dir|claim-id> [--wait] [--max-wait-ms <n>]
  claim <claim-dir|claim-id>

A claim folder holds finding.json, report.md, poc.patch and optionally fix.patch. commit keeps its
files in <claim-dir>/.verdikta-claim/: back that folder up, since losing its keys forfeits the bond.
A run that stops can be run again: it goes on from what was saved, and never pays twice.

Options:
  --json             Print the result as JSON
  --key-file <path>  The wallet key, in a file only you can read
  --rpc-url <url>    The chain's RPC (or VERDIKTA_RPC_URL; default Base Sepolia's public RPC)
  --contract <addr>  The StakeAttestation address (or VERDIKTA_CONTRACT)
  --gateway <url>    An IPFS gateway (or VERDIKTA_IPFS_GATEWAY)
  -h, --help         Show this help
  -v, --version      Print the version

Environment:
  VERDIKTA_WALLET_KEY          The wallet key, instead of --key-file. Never pass a key as an argument.
  VERDIKTA_PIN_BACKEND         kubo, filebase or pinata
  VERDIKTA_PIN_URL             The pin target's base URL
  VERDIKTA_PIN_TOKEN           Its token (filebase, pinata)
  CODE_RUNNER_URL              The code-runner check uses, on this machine
  CODE_RUNNER_TOKEN            Its token
  VERDIKTA_DEV_BUILDER_KEYS    Builder dev keys to accept, comma separated (Base Sepolia and local nodes)
  VERDIKTA_CONFIRMATIONS       Blocks a commit must have before the ciphertext is pinned (default 2)

Base Sepolia and local nodes only, for now.
`;
