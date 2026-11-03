// verdikta-attest: the library (hunter.js) with arguments and printing. Secrets reach this process through the
// environment or a private file, never argv. Everything written goes through a scrubber holding the live secrets,
// and text from elsewhere loses its control characters. An error is printed by its code and fixed text; an unknown
// one by its kind alone, since its message could quote anything.
import fs from 'node:fs';
import { FetchRequest, JsonRpcProvider, Network, Wallet, formatEther, isAddress } from 'ethers';

import { DEFAULT_RPC_URL } from './context.js';
import { fail, ToolError } from './errors.js';
import { createHunter } from './hunter.js';
import { withoutProofText } from './forecast.js';
import { createPinner } from './ipfs.js';
import { forecastFooter } from './notices.js';
import { plainText, scrubber } from './secrets.js';
import { COMMANDS, USAGE } from './usage.js';

export { COMMANDS } from './usage.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const FLAGS = new Set(['--json', '--no-pack', '--remote-runner', '--yes', '--restart', '--accept-unread-pin', '--retrigger', '--wait']);
const VALUES = new Set(['--listing', '--listing-archive', '--key-file', '--rpc-url', '--contract', '--gateway', '--max-wait-ms']);

function usageError(text) {
  return Object.assign(new ToolError('USAGE'), { usage: text });
}

// An option's value is never echoed: someone may have typed a key where a path goes.
function parseArgs(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('-')) {
      const name = a.split('=')[0];
      if (FLAGS.has(name)) {
        options[name] = true;
      } else if (VALUES.has(name)) {
        const inline = a.includes('=') ? a.slice(a.indexOf('=') + 1) : undefined;
        const value = inline ?? args[(i += 1)];
        if (value === undefined) throw usageError(`${name} needs a value`);
        options[name] = value;
      } else {
        throw usageError(`unknown option '${name}'`);
      }
    } else {
      positional.push(a);
    }
  }
  return { options, positional };
}

function walletKey(options, env) {
  let key = null;
  if (options['--key-file']) {
    const file = options['--key-file'];
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      throw fail('WALLET_KEY_FILE', 'It could not be read.');
    }
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw fail('WALLET_KEY_FILE');
    key = fs.readFileSync(file, 'utf8').trim();
  } else if (env.VERDIKTA_WALLET_KEY) {
    key = env.VERDIKTA_WALLET_KEY.trim();
  }
  if (!key) throw fail('WALLET_KEY_MISSING');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw fail('WALLET_KEY_INVALID');
  return key;
}

/** The chain's id without ethers, so a dead or strange RPC ends in an error and not in ethers' retry loop. */
async function chainIdOf(url) {
  const req = new FetchRequest(url);
  req.body = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
  req.timeout = 30_000;
  try {
    const res = await req.send();
    const answer = res.bodyJson;
    if (typeof answer?.result !== 'string') throw new Error('no result');
    return BigInt(answer.result);
  } catch {
    throw fail('RPC_UNAVAILABLE');
  }
}

async function chainProvider(options, env) {
  const url = options['--rpc-url'] ?? env.VERDIKTA_RPC_URL ?? DEFAULT_RPC_URL;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw usageError('VERDIKTA_RPC_URL is not a URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw usageError('VERDIKTA_RPC_URL is not an http(s) URL');
  const chainId = await chainIdOf(url);
  const network = Network.from(chainId);
  return new JsonRpcProvider(url, network, { staticNetwork: network, cacheTimeout: -1, batchMaxCount: 1 });
}

function contractOf(options, env) {
  const contract = options['--contract'] ?? env.VERDIKTA_CONTRACT;
  if (!contract) throw usageError('this needs the StakeAttestation address: --contract or VERDIKTA_CONTRACT');
  if (!isAddress(contract)) throw usageError('VERDIKTA_CONTRACT is not an address');
  return contract;
}

function numberEnv(env, name) {
  const v = env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw usageError(`${name} is not a number`);
  return n;
}

function devKeysOf(env) {
  const list = (env.VERDIKTA_DEV_BUILDER_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list.map((publicKey) => ({ publicKey })) : null;
}

function pinnerOf(env, scrub) {
  const backend = env.VERDIKTA_PIN_BACKEND;
  if (!backend) return undefined;
  if (env.VERDIKTA_PIN_TOKEN) scrub.add(env.VERDIKTA_PIN_TOKEN);
  return createPinner({ backend, url: env.VERDIKTA_PIN_URL, token: env.VERDIKTA_PIN_TOKEN ?? null });
}

const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const asJson = (value) => `${JSON.stringify(value, replacer, 2)}\n`;
const eth = (wei) => `${formatEther(wei)} ETH`;
const when = (s) => (s === 0n || s === undefined ? '-' : `${s} (${new Date(Number(s) * 1000).toISOString()})`);

function printForecast(out, { forecast: f, pack }, { noPack }) {
  if (noPack) out('--no-pack: nothing that can quote your proof is printed, so this says status and codes only.');
  out(`Gate forecast: ${f.verdict.toUpperCase()}`);
  if (f.runner) out(`Runner ${f.runner.version} (${f.runner.runtime}, ${f.runner.platform})${f.image?.ref ? `, image ${f.image.ref}, ${f.image.cache}` : ''}`);
  for (const g of f.gates) out(`  ${g.status === 'pass' ? 'pass' : 'FAIL'}  ${g.name}${g.detail ? `: ${g.detail}` : ''}`);
  if (f.verdict === 'refused') {
    out('The runner refused the listing\'s package, before any of your claim ran. On the arbiters this is a requester error: no commit, and no round settles. Do not commit on it.');
    for (const i of f.refusals) out(`  ${i.code} at ${i.path}: ${i.detail}`);
  }
  if (f.verdict === 'abstain') {
    out(`ABSTAIN: ${f.abstain.cause}${f.abstain.step ? ` at ${f.abstain.step}` : ''}${f.abstain.detail ? `: ${f.abstain.detail}` : ''}`);
    out(f.abstain.cost);
  }
  if (f.reportUnavailable) out(`No report on this platform, only gates and the pack: ${f.reportUnavailable}. The class's platform is linux/amd64.`);
  if (f.compiler !== null && f.compiler !== undefined) out(`Compiler the run pinned: ${f.compiler === '' ? 'none named: the sources\' pragmas pick among the installed releases' : f.compiler}`);
  if (f.build) {
    out(`The build failed. The listing's compiler: ${f.build.compiler || 'chosen by pragma'}.${noPack ? '' : ` Your patch's pragmas: ${f.build.pragmas.join(', ') || 'none'}.`} A proof whose pragma that compiler cannot satisfy fails here.`);
    if (f.build.output) out(f.build.output);
  }
  for (const t of f.tests) out(`  ${t.id}: ${t.runs.join(', ')}${t.message ? `: ${t.message}` : ''}`);
  if (f.settlesAs) out(`Settles as ${f.settlesAs.outcome}, and the bond is ${f.settlesAs.bond}: ${f.settlesAs.reason}.`);
  if (f.verdict === 'pass') out('Every gate would pass, so the jury decides. The jury is not the gates.');
  for (const l of f.lint) out(`Observable, ${l.code}: ${l.detail}${l.names?.length ? ` (${l.names.join(', ')})` : ''}`);
  if (f.observable && f.gates.some((g) => g.name === 'claimedObservable' && g.status === 'fail')) {
    for (const s of f.observable.suggestions) out(`A line that follows the rule: ${s}`);
  }
  for (const h of f.observable?.hints ?? []) out(h);
  if (f.priorFindings?.unread?.length) out(`Prior findings not read, so this pack lacks them: ${f.priorFindings.unread.join(', ')}`);
  for (const n of f.notes) out(n);
  out(forecastFooter());
  if (pack && !noPack) {
    out(`\nContext pack, as jurors would read it (${pack.usedTokens} of ${pack.budgetTokens} tokens). It quotes your proof in the clear, and goes to this terminal only; --no-pack leaves it out.`);
    for (const tier of pack.tiers ?? []) out(`  tier ${tier.rank} ${tier.name}: ${tier.status}, ${tier.delivered} of ${tier.asked}`);
    for (const file of pack.files ?? []) out(`\n--- ${file.name} (${file.tier}) ---\n${file.text}`);
  }
}

function printCommit(out, r) {
  out(`Claim ${r.claimId} on listing ${r.listingId}: ${r.stage}.`);
  out(`Paid ${eth(r.valueWei)}: bond ${eth(r.bondWei)}, prepay ${eth(r.prepayWei)}.`);
  out(`archive sha256 ${r.archiveSha256}`);
  out(`ciphertext sha256 ${r.ciphertextSha256}`);
  out(`ciphertext CID ${r.ciphertextCid}`);
  out(`Revealable at ${when(r.revealableAt)}. Keep .verdikta-claim: losing its keys forfeits the bond.`);
}

function printStatus(out, s) {
  out(`Claim ${s.claimId} on listing ${s.listingId}: ${s.state}${s.outcome ? ` ${s.outcome}` : ''}`);
  if (s.times.revealableAt) out(`Revealable at ${when(s.times.revealableAt)}`);
  if (s.times.revealDeadline) out(`Reveal before ${when(s.times.revealDeadline)}`);
  if (s.times.settleableAt) out(`Settleable at ${when(s.times.settleableAt)}`);
  if (s.times.retriggerDeadline) out(`Re-trigger before ${when(s.times.retriggerDeadline)}`);
  if (s.paidWei) out(`Paid ${eth(s.paidWei)}`);
  if (s.owedWei) out(`Owed ${eth(s.owedWei)}`);
  if (s.evidence) {
    out(`Execution evidence: ${s.evidence.settlement}`);
    if (s.evidence.integrityFailedChecks?.length) out(`Failed integrity checks: ${s.evidence.integrityFailedChecks.join(', ')}`);
    if (s.evidence.tamperFlags && s.evidence.tamperFlags !== 'none') out(`Tamper flags: ${s.evidence.tamperFlags}`);
    if (s.evidence.reportSha256) out(`Report sha256 ${s.evidence.reportSha256}`);
  }
  if (s.next) out(s.next);
}

function claimTarget(positional) {
  const target = positional[0];
  if (target === undefined) throw usageError('this needs a claim folder or a claim id');
  return /^[0-9]+$/.test(target) ? { claimId: BigInt(target) } : { claimDir: target };
}

async function dispatch(verb, args, io, env, write) {
  const { options, positional } = parseArgs(args);
  if (positional.length > 1) throw usageError('too many arguments');
  const out = (text) => write(io.stdout, `${text}\n`);
  const json = options['--json'] === true;
  const scrub = write.scrub;

  const needsDir = () => {
    if (!positional[0]) throw usageError(`${verb} needs a claim folder`);
    return positional[0];
  };
  const listingOf = () => {
    const v = options['--listing'];
    if (v === undefined) return undefined;
    if (!/^[0-9]+$/.test(v)) throw usageError('--listing is a listing id');
    return BigInt(v);
  };
  const waitOptions = {
    confirmations: numberEnv(env, 'VERDIKTA_CONFIRMATIONS'),
    pollMs: numberEnv(env, 'VERDIKTA_POLL_MS'),
    waitMs: numberEnv(env, 'VERDIKTA_WAIT_MS'),
    readBackMs: numberEnv(env, 'VERDIKTA_READBACK_MS'),
    receiptGraceMs: numberEnv(env, 'VERDIKTA_RECEIPT_GRACE_MS'),
  };
  const gateway = options['--gateway'] ?? env.VERDIKTA_IPFS_GATEWAY;
  // With --json, stdout is the result alone.
  const shared = { scrub, gateway, devKeys: devKeysOf(env), onNotice: (t) => write(json ? io.stderr : io.stdout, `${t}\n`), ...waitOptions };
  const needsIpfs = () => {
    if (!gateway) throw usageError(`${verb} needs an IPFS gateway: --gateway or VERDIKTA_IPFS_GATEWAY`);
    if (!env.VERDIKTA_PIN_BACKEND) throw usageError(`${verb} needs a pin target: VERDIKTA_PIN_BACKEND (kubo, filebase or pinata)`);
  };
  const chainOptions = async () => {
    contractOf(options, env);
    return { provider: await chainProvider(options, env), contract: contractOf(options, env) };
  };
  const walletOptions = async () => {
    const { provider, contract } = await chainOptions();
    const key = walletKey(options, env);
    scrub.add(key);
    delete env.VERDIKTA_WALLET_KEY;
    return { provider, contract, signer: new Wallet(key, provider) };
  };

  switch (verb) {
    case 'check': {
      const claimDir = needsDir();
      const listingId = listingOf();
      const archiveFile = options['--listing-archive'];
      if ((listingId === undefined) === (archiveFile === undefined)) throw usageError('check needs --listing <id> or --listing-archive <file>');
      if (!env.CODE_RUNNER_URL || !env.CODE_RUNNER_TOKEN) throw fail('RUNNER_NOT_CONFIGURED');
      scrub.add(env.CODE_RUNNER_TOKEN);
      const runner = { url: env.CODE_RUNNER_URL, token: env.CODE_RUNNER_TOKEN, allowRemote: options['--remote-runner'] === true };
      const chain = listingId !== undefined ? await chainOptions() : {};
      const hunter = createHunter({ ...shared, ...chain, runner });
      let listingArchive;
      if (archiveFile !== undefined) {
        try {
          listingArchive = fs.readFileSync(archiveFile);
        } catch {
          throw fail('LISTING_ARCHIVE_INVALID');
        }
      }
      const r = await hunter.check({ claimDir, listingId, listingArchive });
      const noPack = options['--no-pack'] === true;
      const shown = noPack ? { forecast: withoutProofText(r.forecast), pack: null } : r;
      if (json) write(io.stdout, asJson({ forecast: shown.forecast, pack: shown.pack }));
      else printForecast(out, shown, { noPack });
      return r.forecast.verdict === 'pass' ? 0 : 1;
    }
    case 'commit': {
      const claimDir = needsDir();
      needsIpfs();
      const hunter = createHunter({ ...shared, ...(await walletOptions()), pinner: pinnerOf(env, scrub) });
      const r = await hunter.commit({ claimDir, listingId: listingOf(), acknowledge: options['--yes'] === true, restart: options['--restart'] === true, acceptUnreadPin: options['--accept-unread-pin'] === true });
      if (json) write(io.stdout, asJson(r));
      else printCommit(out, r);
      return 0;
    }
    case 'reveal': {
      const claimDir = needsDir();
      needsIpfs();
      const hunter = createHunter({ ...shared, ...(await walletOptions()), pinner: pinnerOf(env, scrub) });
      const r = await hunter.reveal({ claimDir, retrigger: options['--retrigger'] === true });
      if (json) write(io.stdout, asJson(r));
      else {
        out(`Claim ${r.claimId}: ${r.state}.`);
        if (r.bcid) out(`bCID ${r.bcid}`);
        if (r.topUpWei) out(`Top-up ${eth(r.topUpWei)}`);
        if (r.next) out(r.next);
      }
      return 0;
    }
    case 'status': {
      const target = claimTarget(positional);
      const maxWait = options['--max-wait-ms'];
      if (maxWait !== undefined && !/^[0-9]+$/.test(maxWait)) throw usageError('--max-wait-ms is a number');
      const hunter = createHunter({ ...shared, ...(await chainOptions()) });
      const r = await hunter.status({ ...target, wait: options['--wait'] === true, maxWaitMs: maxWait === undefined ? undefined : Number(maxWait) });
      if (json) write(io.stdout, asJson(r));
      else printStatus(out, r);
      return r.timedOut ? 4 : 0;
    }
    case 'claim': {
      const target = claimTarget(positional);
      const hunter = createHunter({ ...shared, ...(await walletOptions()) });
      const r = await hunter.claim(target);
      if (json) write(io.stdout, asJson(r));
      else {
        for (const s of r.sent) out(`Sent ${s.action}: ${s.tx}`);
        printStatus(out, r);
      }
      return 0;
    }
    default:
      throw usageError(`unknown command '${verb}'`);
  }
}

/**
 * Runs the CLI and returns its exit code: 0 on success, 1 refused or failed, 2 a usage error, 3 an acknowledgement
 * needed, 4 still pending (run the same command again).
 * @param {string[]} argv arguments after the program name
 * @param {{ stdout: { write(s: string): unknown }, stderr: { write(s: string): unknown } }} io
 * @param {Record<string, string|undefined>} env
 */
export async function run(argv, { stdout, stderr } = process, env = process.env) {
  const scrub = scrubber();
  const write = (stream, text) => stream.write(scrub(plainText(text)));
  write.scrub = scrub;
  const io = { stdout, stderr };
  const [first, ...rest] = argv;
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
    write(stderr, `verdikta-attest: unknown option '${first.split('=')[0]}'\n\n${USAGE}`);
    return 2;
  }
  if (!Object.hasOwn(COMMANDS, first)) {
    write(stderr, `verdikta-attest: unknown command '${first}'\n\n${USAGE}`);
    return 2;
  }
  try {
    return await dispatch(first, rest, io, env, write);
  } catch (err) {
    if (err instanceof ToolError) {
      if (err.usage) write(stderr, `verdikta-attest: ${first}: ${err.usage}\n`);
      else write(stderr, `verdikta-attest: ${err.code}: ${err.message}\n`);
      return err.exitCode;
    }
    write(stderr, `verdikta-attest: INTERNAL: ${err?.name ?? 'Error'}\n`);
    return 1;
  }
}
