// A stand-in for iptables (the filter table's user chains, as `-S` prints them) and for the one docker command
// action/egress-rules.sh runs, so its unit test can run the real script on any machine with no root and no
// daemon. The state is a JSON file; every call is appended to a log. `evaluate` walks the chains for a packet,
// as the kernel would for the matches the script uses (-d, -p, --dport, -j), so a test can ask what a
// container's packet meets.
//
//   node iptablesStub.js iptables <args...>   (STUB_STATE, STUB_LOG)
//   node iptablesStub.js docker <args...>     (STUB_IPV6: what the default bridge's EnableIPv6 prints)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB = fileURLToPath(import.meta.url);

/** A folder holding `iptables` and `docker` that run this stub, and its state; `chains` is the starting table. */
export function stubBin(chains = { 'DOCKER-USER': ['-j RETURN'] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vab-egress-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['iptables', 'docker']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${name} "$@"\n`, { mode: 0o755 });
  }
  const state = path.join(dir, 'state.json');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(state, JSON.stringify({ chains }));
  fs.writeFileSync(log, '');
  return {
    dir,
    bin,
    env: { STUB_STATE: state, STUB_LOG: log },
    chains: () => JSON.parse(fs.readFileSync(state, 'utf8')).chains,
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * The verdict a packet meets in DOCKER-USER: 'DROP', or 'RETURN' (back to FORWARD, and on to Docker's own chains).
 * @param {Record<string, string[]>} chains
 * @param {{ dst: string, proto: 'tcp'|'udp'|'icmp', dport?: number }} packet
 */
export function evaluate(chains, packet, chain = 'DOCKER-USER', depth = 0) {
  if (depth > 8) throw new Error('a loop of jumps');
  for (const rule of chains[chain] ?? []) {
    const words = rule.split(' ');
    const opt = (name) => {
      const i = words.indexOf(name);
      return i === -1 ? null : words[i + 1];
    };
    const dst = opt('-d');
    if (dst !== null && dst !== `${packet.dst}/32` && dst !== packet.dst) continue;
    const proto = opt('-p');
    if (proto !== null && proto !== packet.proto) continue;
    const dport = opt('--dport');
    if (dport !== null && Number(dport) !== packet.dport) continue;
    const target = opt('-j');
    if (target === 'DROP' || target === 'ACCEPT') return target;
    if (target === 'RETURN') return depth === 0 ? 'RETURN' : null;
    if (chains[target]) {
      const v = evaluate(chains, packet, target, depth + 1);
      if (v !== null) return v;
      continue;
    }
    throw new Error(`a target the stub does not know: ${rule}`);
  }
  return depth === 0 ? 'RETURN' : null;
}

function iptables(args) {
  const file = process.env.STUB_STATE;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  const a = args.filter((x) => x !== '-w' && x !== '-n');
  const [op, chain, ...rest] = a;
  const rule = rest.join(' ');
  const has = Object.hasOwn(state.chains, chain ?? '');
  switch (op) {
    case '-L':
      return has ? 0 : 1;
    case '-N':
      if (has) return 1;
      state.chains[chain] = [];
      save();
      return 0;
    case '-F':
      if (!has) return 1;
      state.chains[chain] = [];
      save();
      return 0;
    case '-A':
      if (!has) return 1;
      state.chains[chain].push(rule);
      save();
      return 0;
    case '-I': {
      if (!has) return 1;
      const pos = /^[0-9]+$/.test(rest[0]) ? Number(rest[0]) : 1;
      const r = /^[0-9]+$/.test(rest[0]) ? rest.slice(1).join(' ') : rule;
      state.chains[chain].splice(pos - 1, 0, r);
      save();
      return 0;
    }
    case '-C':
      return has && state.chains[chain].includes(rule) ? 0 : 1;
    case '-D': {
      if (!has) return 1;
      const i = state.chains[chain].indexOf(rule);
      if (i === -1) return 1;
      state.chains[chain].splice(i, 1);
      save();
      return 0;
    }
    case '-S':
      if (!has) return 1;
      process.stdout.write(`-N ${chain}\n${state.chains[chain].map((r) => `-A ${chain} ${r}\n`).join('')}`);
      return 0;
    default:
      process.stderr.write(`iptables stub: ${args.join(' ')} is not something it knows\n`);
      return 2;
  }
}

function docker(args) {
  if (args.join(' ') === 'network inspect bridge --format {{.EnableIPv6}}') {
    process.stdout.write(`${process.env.STUB_IPV6 ?? 'false'}\n`);
    return 0;
  }
  process.stderr.write(`docker stub: ${args.join(' ')} is not something it knows\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === STUB) {
  const [tool, ...args] = process.argv.slice(2);
  fs.appendFileSync(process.env.STUB_LOG, `${tool} ${args.join(' ')}\n`);
  process.exitCode = tool === 'iptables' ? iptables(args) : docker(args);
}
