// The hunter's commands, and the help text.
import { CONSEQUENCE, REQUIREMENT } from './notices.js';

/** Words to lines of at most `width` columns. */
function wrap(text, width = 100) {
  const lines = [];
  for (const word of text.split(' ')) {
    if (lines.length > 0 && lines.at(-1).length + 1 + word.length <= width) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines.join('\n');
}

export const COMMANDS = {
  check: 'Run the arbiters\' pipeline minus the jury on a claim, locally',
  commit: 'Encrypt a claim to the maker\'s disclosure key, commit it on-chain, then pin and disclose it',
  reveal: 'Pin the plaintext claim and reveal it once it is revealable',
  status: 'Show a claim\'s state and its pending evaluation',
  claim: 'Finalize, settle and withdraw a claim\'s payout',
  appeal: 'Appeal an INVALID to the dispute panel, or re-trigger the appeal\'s round',
};

export const USAGE = `Usage: verdikta-attest <command> [options]

Hunter tool for Verdikta stake attestation: prove a bug in a staked version of
someone's code with a runnable test, disclose it to the maker first, and have the
Verdikta arbiters judge it after the fix window.

Commands:
${Object.entries(COMMANDS).map(([name, about]) => `  ${name.padEnd(8)}${about}`).join('\n')}

  check <claim-dir> (--listing <id> | --listing-archive <file>) [--no-pack] [--remote-runner]
                     run it before committing: nothing leaves this machine, and it is the only place some
                     failures show. commit does not ask for it
                     --no-pack prints status and codes only: no pack, and nothing else that can quote the proof
                     a folder with none of a claim's files is refused, with no forecast: it says nothing of a claim
                     on a listing that names documents (stake.documents), check shows the documents tier the runner
                     built: the maker's statement of what the code must do. Documents never widen the scope
  commit <claim-dir> --listing <id> [--late] [--yes] [--restart] [--accept-unread-pin]
                     on a folder with no commit signed yet, without --yes it prints the terms, the price and how
                     many claims on the listing are open ahead of yours, and sends nothing
                     --late files a late claim, on a listing that takes no commit any more: its stake has rolled
                     forward, or closed after it opened, or its maker holds it. A late claim is judged and recorded,
                     and pays no award. It costs what a commit costs; the bond is forfeited on INVALID, unless
                     the INVALID is narrow, and the prepay is spent on the evaluation. The wrong kind for the
                     listing is refused, with or without --late, before anything is pinned or sent. Once a folder
                     holds a late claim, prepared or signed, a later run goes on with that one, with --late or
                     without it; --late changes nothing in a folder that holds a signed commit. The price it
                     signs is the price its terms named. A prepared late claim whose two hashes already have a
                     claim on the chain is disclosed on any run, --yes or not, as a signed one is. --restart
                     does not start a late claim over: a changed one goes in a new folder
                     --late is the bare flag, on commit only: with a value (--late=false too) or on another
                     command it is a usage error, and nothing is read or sent
  reveal <claim-dir> [--retrigger] [--yes]
                     pins the plaintext and pays any top-up the live fee needs; prints it, and sends only with --yes
                     --retrigger pays the top-up to send a failed round again; prints it, and sends only with --yes
  status <claim-dir|claim-id> [--wait] [--max-wait-ms <n>]
                     a round with no verdict reads as one as soon as the aggregator's time for it is over, before
                     anyone finalizes it; the reveal deadline is the chain's, and status says when a release moved it
                     claims on a listing reveal in commit order: status names the earlier claim yours waits for
  claim <claim-dir|claim-id> [--waive-appeal]
                     --waive-appeal settles your own INVALID before anyone else may, which waives its appeal
                     on a settled claim, claim and status say who sent the settle (this run, the hunter's own
                     address or another), its transaction and block, and what its Settled event paid and left owed
  appeal <claim-dir|claim-id> [--yes]
                     pays the live dispute fee for one round of the dispute panel; prints it, and sends only with --yes

A claim folder holds finding.json, report.md, poc.patch and optionally fix.patch. commit keeps its
files in <claim-dir>/.verdikta-claim/: back that folder up, since losing its keys forfeits the bond.
A run that stops can be run again: it goes on from what was saved, and never pays twice.

Writing report.md:
${CONSEQUENCE}
${wrap(REQUIREMENT)}
check warns, and refuses nothing, when report.md has no such section; commit says so again.

Exit codes:
  0  done
  1  refused or failed (check: its forecast short of a pass)
  2  usage error
  3  it needs --yes or --waive-appeal: read what it printed, then run it again with that flag
  4  still pending (a transaction, or status --wait out of time): run the same command again
  5  status --wait: the claim's round ended with no verdict, finalized or not yet: read what it printed

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
