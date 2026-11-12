#!/usr/bin/env node
// Do the baseline scan's sandbox limits hold under this host's Docker? (node P23; stake-attestation/README.md,
// "Running the site"). The scan runs each tool in a container with the code-runner's sandbox flags, among them
// --memory, --memory-swap, --pids-limit and --cpus (builder/src/docker.js). A rootless daemon whose user's manager
// was not delegated the cgroup controllers drops those limits with a warning and runs the container anyway, so a scan
// would run unbounded. This pulls the pinned image the scan pulls (gitleaks, builder/src/scanTools.js), runs it the
// way the scan runs a tool (runSandboxed, the same flags), reads the container's own cgroup files and compares them
// with the limits those flags set. Exit 0 when every limit holds, 1 otherwise.
//
// Run it as the site's service user, against the daemon the server's environment names:
//   sudo -u verifiers DOCKER_HOST=unix:///run/user/$(id -u verifiers)/docker.sock \
//     node /opt/verdikta-verifiers/stake-attestation/deploy/check-scan-limits.mjs
// It needs the builder's dependencies (npm ci in stake-attestation/builder), as the scan does.
import { fileURLToPath } from 'node:url';

import { createDocker, runSandboxed, sandboxRunArgs } from '../builder/src/docker.js';
import { SCAN_TOOLS } from '../builder/src/scanTools.js';

// The class platform, the scan's (builder.json sets no other).
const PLATFORM = 'linux/amd64';
const FILES = ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'];

/** What the scan's flags set, read from the argv the scan's own sandbox builds. */
function limitsOfTheScan() {
  const args = sandboxRunArgs({ image: 'x', platform: PLATFORM, name: 'n', label: 'l', argv: ['true'] });
  const flag = (name) => args[args.indexOf(name) + 1];
  const mb = (v) => Number(/^(\d+)m$/.exec(v)[1]);
  return {
    'memory.max': String(mb(flag('--memory')) * 1024 * 1024),
    // --memory-swap equal to --memory: no swap at all
    'memory.swap.max': String((mb(flag('--memory-swap')) - mb(flag('--memory'))) * 1024 * 1024),
    'pids.max': flag('--pids-limit'),
    'cpu.max': `${Math.round(Number(flag('--cpus')) * 100000)} 100000`,
  };
}

/**
 * @param {{ docker?: { run(args: string[], o?: object): Promise<object> }, log?: (line: string) => void }} [o]
 * @returns {Promise<number>} the exit code
 */
export async function checkScanLimits({ docker = createDocker(), log = (l) => console.log(l) } = {}) {
  const image = SCAN_TOOLS.gitleaks.image;
  const pull = await docker.run(['pull', '--quiet', '--platform', PLATFORM, image], { timeoutMs: 900000 });
  if (pull.spawnError || pull.exitCode !== 0) {
    log(`FAIL: the scan's pinned image ${image} could not be pulled: is DOCKER_HOST this user's rootless daemon?`);
    return 1;
  }
  // as the scan's runTool calls it: input on stdin (none here), no logging driver
  const r = await runSandboxed({ docker, image, platform: PLATFORM, argv: ['cat', ...FILES.map((f) => `/sys/fs/cgroup/${f}`)], stdin: Buffer.alloc(0), keepLogs: false, timeoutMs: 120000 });
  if (r.spawnError || r.exitCode !== 0) {
    log(`FAIL: the sandboxed container did not run (exit ${r.exitCode ?? r.spawnError}): ${String(r.stderr ?? '').trim().slice(0, 500)}`);
    return 1;
  }
  const got = String(r.stdout).trim().split('\n').map((s) => s.trim());
  if (got.length !== FILES.length) {
    log(`FAIL: expected ${FILES.length} cgroup values, read ${got.length}: is this cgroup v2?`);
    return 1;
  }
  const want = limitsOfTheScan();
  const wrong = FILES.filter((f, i) => got[i] !== want[f]);
  for (const [i, f] of FILES.entries()) log(`${wrong.includes(f) ? 'WRONG' : 'ok'}  ${f}: ${got[i]} (the scan sets ${want[f]})`);
  if (wrong.length) {
    log(`FAIL: ${wrong.join(', ')} not held. Delegate cpu, memory and pids to the user's manager (deploy/systemd/user@.service.d/delegate.conf: Delegate=), restart it and the rootless daemon, and run this again.`);
    return 1;
  }
  log('OK: the scan\'s memory, swap, pids and cpu limits hold under this daemon');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  checkScanLimits().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`FAIL: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
