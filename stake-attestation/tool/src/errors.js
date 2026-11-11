// Every error the tool raises. The text is fixed here, with public values (ids, hashes, times) added by the
// caller. No error relays the text of an ethers error, an RPC, a pin service or a runner's credentials: ethers
// puts a transaction's calldata in its messages, and at reveal that calldata holds the keys. So a ToolError has
// no `cause`, and what is known of a failure from outside is a code or an allow-listed revert reason.
export const ERROR_TEXTS = Object.freeze({
  ARCHIVE_INVALID: 'The listing archive is not, byte for byte, what the listing flow issues for its files, so the builder did not sign this listing. Refused.',
  ARCHIVE_MISMATCH: 'What the chain holds for this listing is not what its signed archive says: another artifact, disclosure key or terms. A proof encrypted to it could cost the bond at the arbiters\' gate. Refused.',
  ARCHIVE_NOT_CID: 'The gateway answered bytes that are not this CID.',
  ARCHIVE_TOO_LARGE: 'The archive is larger than this tool reads.',
  ARCHIVE_UNAVAILABLE: 'A listing archive could not be read from the gateway. Nothing was sent; try again.',
  CIPHERTEXT_CID_DIFFERS: 'The pin target answered a CID other than the one disclosed. Nothing was sent.',
  CLAIM_ENDED: 'This claim has ended.',
  CLAIM_MISMATCH: 'The claim on-chain is not the one this folder committed. Nothing was pinned or sent.',
  COMMIT_REVERTED: 'The commit transaction reverted, so no claim exists and nothing was pinned. Run commit again to price it afresh.',
  CONTRACT_REFUSED: 'The contract refused the call.',
  DISCLOSE_REVERTED: 'The disclose transaction reverted. Run commit again to resume.',
  DISCLOSE_WINDOW_OVER: 'The disclose window is over, so the ciphertext was not pinned: publishing it would buy nothing. Anyone may expire this claim: the bond goes to the maker and the prepay comes back to you.',
  FILE_CHANGED: 'A saved file is not what the commitment says. Nothing was pinned or sent.',
  FILE_ERROR: 'A file could not be read or written.',
  FILE_MISSING: 'A saved file is missing, and it cannot be made again: losing the keys or the archive forfeits the bond.',
  FILE_NOT_PRIVATE: 'A file or folder here is readable by someone else, is a link, or belongs to another user. Refused rather than repaired, since its contents may have been seen.',
  FINDING_INVALID: 'finding.json would settle INVALID: fix it first. Nothing was sent.',
  FOLDER_BUSY: 'Another run of this tool holds this claim folder.',
  INPUTS_CHANGED: 'The claim files changed since this commit was prepared, and nothing has been signed. Restore them, or pass --restart to draw new keys for the new files.',
  INSUFFICIENT_FUNDS: 'This wallet cannot pay for this. Nothing was sent.',
  INTERNAL: 'The tool failed unexpectedly.',
  LISTING_ARCHIVE_INVALID: 'That is no listing archive this tool can read.',
  LISTING_NOT_ACCEPTING: 'This listing takes no commits now.',
  LISTING_NOT_FOUND: 'No such listing on this contract.',
  NEEDS_ACKNOWLEDGEMENT: 'Read the above, then run again with --yes. Nothing was sent.',
  NETWORK_NOT_ALLOWED: 'This tool is for Base Sepolia and local nodes for now. Refused.',
  NOTHING_TO_WITHDRAW: 'This wallet has nothing to withdraw.',
  NOT_ALLOWED: 'This listing is invited, and this wallet is not on its list.',
  NOT_DISCLOSED: 'This claim has not been disclosed. Run commit again to finish it, before the disclose window ends. The plaintext was not pinned.',
  NOT_READY: 'Not ready yet.',
  NOT_REVEALABLE_YET: 'The fix window is still open. The plaintext was not pinned.',
  NOT_SIGNED_BY_BUILDER: 'The builder did not sign this listing: its attestation does not verify. Arbiters would not judge a claim on it. Refused.',
  NOT_THE_CONTRACT: 'There is no StakeAttestation at that address on this chain.',
  NO_CLAIM_HERE: 'This folder holds no commit.',
  OUT_OF_ORDER: 'An earlier claim on this listing is not settled or expired, and claims reveal in commit order. The plaintext was not pinned.',
  PIN_BAD_CID: 'The pin target answered no CID the contract can store. Nothing was sent.',
  PIN_CID_MISMATCH: 'The pin target answered a CID that is not the CID of the bytes sent. Nothing was sent.',
  PIN_CONFIG: 'The pinning settings are not usable.',
  PIN_FAILED: 'The pin target did not take the upload. Nothing was sent; run again.',
  PIN_NOT_READABLE: 'The pinned bytes could not be read back through the gateway. Nothing was sent; run again.',
  PIN_READBACK_MISMATCH: 'The gateway serves other bytes under the pinned CID. Nothing was sent.',
  POC_INVALID: 'poc.patch would settle INVALID: fix it first. Nothing was sent.',
  REPORT_INVALID: 'report.md would settle INVALID: fix it first. Nothing was sent.',
  RESTART_REFUSED: 'A transaction has been signed for this claim, so its files stay. --restart only works before that.',
  RETRIGGER_REFUSED: 'The contract would refuse this re-trigger. Nothing was sent.',
  REVEAL_REFUSED: 'The contract would refuse this reveal. The plaintext was not pinned.',
  REVEAL_REVERTED: 'The reveal transaction reverted. Run reveal again to see where the claim stands.',
  REVEAL_WINDOW_OVER: 'The reveal window is over, so the plaintext was not pinned. Anyone may expire this claim: the bond goes to the maker.',
  RPC_UNAVAILABLE: 'The RPC did not give a usable answer. What was saved stays saved: run the same command again.',
  RUNNER_ANSWER_INVALID: 'The code-runner answered something this tool cannot read.',
  RUNNER_BODY_TOO_LARGE: 'The code-runner refused the request for its size.',
  RUNNER_NOT_CONFIGURED: 'check needs CODE_RUNNER_URL and CODE_RUNNER_TOKEN.',
  RUNNER_NOT_LOCAL: 'CODE_RUNNER_URL is not this machine, and a runner reads the plaintext claim. Pass --remote-runner if you mean it.',
  RUNNER_UNAUTHORIZED: 'The code-runner refused the token in CODE_RUNNER_TOKEN.',
  RUNNER_UNREACHABLE: 'The code-runner could not be reached at CODE_RUNNER_URL.',
  STATE_INVALID: 'state.json cannot be read. It was left as it is; nothing was drawn or sent.',
  STATE_MISMATCH: 'This folder belongs to another wallet, listing, chain or contract.',
  TX_PENDING: 'The transaction is not mined yet. It stays saved: run the same command again to wait for it, and no second one is sent.',
  USAGE: 'Usage error.',
  WALLET_KEY_FILE: 'The wallet key file must be a regular file only you can read (0600 or 0400).',
  WALLET_KEY_INVALID: 'The wallet key is not 32 bytes of hex.',
  WALLET_KEY_MISSING: 'This needs a wallet: VERDIKTA_WALLET_KEY in the environment, or --key-file <path>.',
});

const EXIT = Object.freeze({ USAGE: 2, NEEDS_ACKNOWLEDGEMENT: 3, TX_PENDING: 4 });

export class ToolError extends Error {
  /**
   * @param {keyof typeof ERROR_TEXTS} code
   * @param {string} [detail] - public values only, added after the fixed text
   */
  constructor(code, detail) {
    const base = ERROR_TEXTS[code] ?? ERROR_TEXTS.INTERNAL;
    super(detail ? `${base} ${detail}` : base);
    this.name = 'ToolError';
    this.code = code;
    this.detail = detail ?? null;
    this.exitCode = EXIT[code] ?? 1;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export const fail = (code, detail) => new ToolError(code, detail);

// Every revert string in onchain/contracts (test/abi.test.js holds this list to them). Only these are ever
// repeated from a failure: anything else stays unnamed, since a node's message can quote the calldata.
export const KNOWN_REVERTS = Object.freeze([
  'active listing exists', 'allowlist too long', 'already closed', 'already disclosed', 'already disputed', 'already flagged', 'already retriggered', 'already started', 'amount owed', 'appeal window open', 'appeal window over', 'awaiting confirmation', 'awards decrease', 'awards owed', 'bad allowlist', 'bad alpha', 'bad archiveHash', 'bad baseCommit', 'bad bcid', 'bad budget', 'bad ciphertextCid', 'bad ciphertextSha256', 'bad claimId', 'bad dispute oracle fee', 'bad disputeCid', 'bad fee recipient', 'bad fee scaling', 'bad knownIssueIds', 'bad listingCid', 'bad listingId', 'bad lowestClassCounted', 'bad oracle fee', 'bad repo', 'bad statementCid', 'base cost must be below dispute fee', 'base cost must be below fee', 'claims pending', 'confirmation deadline over', 'contract artifact needs a deployment', 'counted class pays nothing', 'disclose window over', 'dispute oracle fee above ceiling', 'dispute window open', 'dispute window over', 'dispute window too long', 'dispute window too short', 'earlier claim unresolved', 'escrow below fee', 'escrow below top award', 'evaluation not ready', 'fee changed', 'fee not paid', 'fix window open', 'fix window too long', 'floor out of bounds', 'gas below INLINE_REFUND_GAS_NEEDED', 'gas below SUBMISSION_GAS_NEEDED', 'grace exceeds fix window', 'grace over', 'no confirmation due', 'no disclosure key', 'no value', 'not INVALID', 'not a valid outcome', 'not accepting commits', 'not allowed', 'not committed', 'not disclosed', 'not failed', 'not fundable', 'not hunter', 'not in fix window', 'not judged', 'not maker', 'not renewable', 'not requester', 'not revealed', 'not rollable', 'nothing to recover', 'nothing to withdraw', 'oracle fee above ceiling', 'payment below bond + fee', 'plain ETH refused', 'prepay below fee', 'reentrant', 'repatriate failed', 'repo artifact has a deployment', 'retrigger window open', 'retrigger window over', 'reveal window open', 'reveal window over', 'reveal window too long', 'reveal window too short', 'self only', 'too many known issues', 'unknown function', 'unknown wallet', 'withdraw failed', 'wrong fee', 'zero aggregator',
]);

// Longest first, so 'not disclosed' cannot shadow something that contains it.
const BY_LENGTH = [...KNOWN_REVERTS].sort((a, b) => b.length - a.length);

/** The contract's revert reason in an ethers or node error, if it is one of its own strings; else null. */
export function revertReasonOf(err) {
  const seen = new Set();
  const texts = [];
  const walk = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      texts.push(value);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of ['reason', 'shortMessage', 'message', 'data', 'info', 'error', 'revert', 'args']) walk(value[key], depth + 1);
  };
  walk(err, 0);
  for (const text of texts) {
    const direct = /reverted with reason string '([^']*)'|execution reverted: ([^"\n]*)/.exec(text);
    const named = direct?.[1] ?? direct?.[2];
    if (named !== undefined) {
      const hit = BY_LENGTH.find((r) => r === named.trim());
      if (hit) return hit;
    }
    if (BY_LENGTH.includes(text)) return text;
    const decoded = decodeErrorString(text);
    if (decoded && BY_LENGTH.includes(decoded)) return decoded;
  }
  return null;
}

// Error(string) in revert data: 0x08c379a0, offset, length, bytes.
function decodeErrorString(text) {
  if (!/^0x08c379a0[0-9a-fA-F]+$/.test(text) || text.length < 10 + 128) return null;
  try {
    const length = Number.parseInt(text.slice(10 + 64, 10 + 128), 16);
    return Buffer.from(text.slice(10 + 128, 10 + 128 + length * 2), 'hex').toString('utf8');
  } catch {
    return null;
  }
}
