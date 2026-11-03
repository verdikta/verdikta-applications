// The services of a round. The arbiter's come from verdikta-arbiter at the pin: A6a's IPFS, its
// recording proxy, its service starters and registry helper, called as they are. This repository's
// are started as a deployment would start them: their own entry points, configured by environment,
// each given only what it needs.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { APP_DIR } from './setup.js';
import { freePort, launch, must, waitUntil } from './proc.js';

const require = createRequire(import.meta.url);

/** registry:2 (2.8.3), the multi-platform index pinned by digest: the same pin as A6a's and the builder's. */
const REGISTRY_IMAGE = 'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';
const PIN_KEY = 'e2e-local-pin-key';

/** What the round takes from verdikta-arbiter's checkout, as it is there. */
export function arbiterHarness(arbiterDir) {
  // code-runner/test/docker/helpers reads the runtime when it loads: runc, as A6a runs it.
  process.env.CODE_RUNNER_RUNTIME = 'runc';
  const fromArbiter = (rel) => require(path.join(arbiterDir, rel));
  const dockerHelpers = fromArbiter('code-runner/test/docker/helpers.js');
  const { runText } = fromArbiter('code-runner/src/docker.js');
  return {
    dir: arbiterDir,
    platform: dockerHelpers.PLATFORM,
    dockerHelpers,
    runText,
    startRegistry: fromArbiter('code-runner/test/docker/registry.js').startRegistry,
    startLocalIpfs: fromArbiter('e2e/src/l2/claim/local-ipfs.js').startLocalIpfs,
    startRecordingProxy: fromArbiter('e2e/src/l2/claim/recording-proxy.js').startRecordingProxy,
    pullChecks: fromArbiter('e2e/src/l2/claim/checks.js').pullChecks,
    gatesPassed: fromArbiter('e2e/src/l2/claim/checks.js').gatesPassed,
    aiRequestChecks: fromArbiter('e2e/src/l2/claim/checks.js').aiRequestChecks,
    ...fromArbiter('e2e/src/l2/claim/services.js'),
  };
}

export const startIpfs = (h) => h.startLocalIpfs({ pinKey: PIN_KEY }).then((ipfs) => ({ ...ipfs, pinKey: PIN_KEY }));

/**
 * For SA_E2E_BREAK=signal-in-start: a startup step that is already under way when a signal arrives, and
 * creates its container only afterwards. It runs apart from this process and names nothing of the run on
 * its command line (the names are in its environment), so no sweep can stop it or see it coming: the
 * case of a docker pull that a docker run follows, which is what a real step does and what a sweep made
 * once, at the signal, leaves behind.
 * @returns {{ name: string, pid: number, done: Promise<string> }}
 */
export function startLateContainer({ instance, seconds, dockerConfigDir }) {
  const name = `${instance}-late-start`;
  const child = spawn('sh', ['-c', 'sleep "$E2E_LATE_SECONDS"; exec docker run --detach --name "$E2E_LATE_NAME" "$E2E_LATE_IMAGE"'], {
    detached: true,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_CONFIG: dockerConfigDir,
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      E2E_LATE_SECONDS: String(seconds),
      E2E_LATE_NAME: name,
      E2E_LATE_IMAGE: REGISTRY_IMAGE,
    },
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(name) : reject(new Error(`the late step exited ${code}`))));
  });
  return { name, pid: child.pid, done };
}

/** For SA_E2E_BREAK=group-survives: a process group of the harness's, with a child, that nothing here will stop. */
export function startSurvivor() {
  const child = spawn('sh', ['-c', 'sleep 300 & wait'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/**
 * A6a's registry:2, which listens on the daemon host's loopback: the daemon pushes to it and the runner
 * pulls from it. Under Docker Desktop that loopback is the VM's, so the builder's reads go through a
 * second registry:2 over the same storage, published on this machine's. On Linux both are one loopback.
 */
export async function startRegistryPair(h, docker, instance) {
  const registry = await h.startRegistry(docker, instance);
  const readName = `${registry.name}-read`;
  try {
    const up = await h.runText(docker, ['run', '--detach', '--name', readName, '--publish', '127.0.0.1::5000', '--volumes-from', `${registry.name}:ro`, REGISTRY_IMAGE], { timeoutMs: 120000 });
    if (up.exitCode !== 0) throw new Error(`the read registry: ${up.stderr}`);
    const port = await h.runText(docker, ['port', readName, '5000/tcp'], { timeoutMs: 30000 });
    const apiUrl = `http://127.0.0.1:${port.stdout.trim().split('\n')[0].split(':').pop()}`;
    await waitUntil('waiting for the read registry', async () => (await fetch(`${apiUrl}/v2/`)).status === 200, { timeoutMs: 30000 });
    return {
      ...registry,
      apiUrl,
      remove: async () => {
        await h.runText(docker, ['rm', '--force', '--volumes', readName], { timeoutMs: 60000 });
        await registry.remove();
      },
    };
  } catch (err) {
    await h.runText(docker, ['rm', '--force', '--volumes', readName], { timeoutMs: 60000 });
    await registry.remove();
    throw err;
  }
}

/** A docker command whose answer the cleanup rests on: a failure is the round's, never an empty answer. */
async function checked(h, docker, args, timeoutMs) {
  const r = await h.runText(docker, args, { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} exited ${r.exitCode}: ${String(r.stderr).slice(0, 300)}`);
  return r.stdout;
}

/** Every image of this run's repository on the daemon (the builder's tag, the runner's pull). */
export async function removeRunImages(h, docker, instance) {
  const listed = await checked(h, docker, ['image', 'ls', '--digests', '--format', '{{.Repository}}\t{{.Tag}}\t{{.Digest}}'], 60000);
  const refs = new Set();
  for (const line of listed.split('\n').filter(Boolean)) {
    const [repo, tag, digest] = line.split('\t');
    if (!repo.includes(`/${instance}/`)) continue;
    if (tag && tag !== '<none>') refs.add(`${repo}:${tag}`);
    if (digest && digest !== '<none>') refs.add(`${repo}@${digest}`);
  }
  if (refs.size) await checked(h, docker, ['image', 'rm', '--force', ...refs], 120000);
  return [...refs];
}

/**
 * What of this run the daemon still holds: a container whose name, image or labels name the instance
 * (the runner's sandboxes, A6a's registry, a builder step on the run's image), one of `names` (a builder
 * step on a shared image, named by its process), and the images of the run's repository.
 * @throws {Error} when Docker cannot say: an inventory that failed is not an empty one
 */
export async function leftovers(h, docker, instance, names = []) {
  const containers = await checked(h, docker, ['ps', '--all', '--format', '{{.Names}}\t{{.Image}}\t{{.Labels}}'], 30000);
  const images = await checked(h, docker, ['image', 'ls', '--format', '{{.Repository}}'], 30000);
  return {
    containers: containers.split('\n').filter((l) => l.includes(instance) || names.includes(l.split('\t')[0])).map((l) => l.split('\t')[0]),
    images: [...new Set(images.split('\n').filter((l) => l.includes(`/${instance}/`)))],
  };
}

/** Removes what leftovers finds. */
export async function removeRunContainers(h, docker, instance, names = []) {
  const found = (await leftovers(h, docker, instance, names)).containers;
  if (found.length) await checked(h, docker, ['rm', '--force', '--volumes', ...found], 120000);
  return found;
}

/**
 * The docker CLI's config for the builder: empty, so a push reads no credential (the registry is local
 * and open). An operator's config can name a credential helper, and on a locked keychain
 * `docker-credential-desktop get` waits for ever, before the push reaches the registry. buildx comes
 * along, since the CLI looks for its plugins beside its config.
 */
export function cleanDockerConfig(workDir) {
  const dir = path.join(workDir, 'docker-config');
  fs.mkdirSync(path.join(dir, 'cli-plugins'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}\n', { mode: 0o600 });
  const buildx = path.join(os.homedir(), '.docker', 'cli-plugins', 'docker-buildx');
  if (fs.existsSync(buildx)) fs.symlinkSync(fs.realpathSync(buildx), path.join(dir, 'cli-plugins', 'docker-buildx'));
  return dir;
}

/** The real server: its indexer and keeper, the real builder as its builder, this run's chain and IPFS. */
export async function startServer({ workDir, logDir, chain, ipfs, registry, runnerProxyUrl, runnerToken, platform, repository, dockerConfig, instance }) {
  const builderConfig = path.join(workDir, 'builder.json');
  const arm = platform !== 'linux/amd64';
  fs.writeFileSync(builderConfig, JSON.stringify({
    registry: { repository: `${registry.host}/${instance}/env`, apiUrl: registry.apiUrl },
    runner: { url: runnerProxyUrl, tokenEnv: 'E2E_RUNNER_TOKEN' },
    // Off the class platform the builder indexes both and runs its own (development only: the report's devOnly says so).
    ...(arm ? { platforms: { setup: platform, run: platform, extra: [platform] } } : {}),
    repoMirrors: { [repository.url]: repository.mirror },
    signing: { key: 'dev' },
    control: { gitHosts: [new URL(repository.url).host] },
  }, null, 2));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const buildsDir = path.join(workDir, 'builds');
  fs.mkdirSync(buildsDir, { recursive: true });
  const passDocker = ['DOCKER_CONFIG', ...(process.env.DOCKER_HOST ? ['DOCKER_HOST'] : [])];
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_CONFIG: dockerConfig,
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    E2E_RUNNER_TOKEN: runnerToken,
    PORT: String(port),
    HOST: '127.0.0.1',
    SA_CHAIN_ID: '31337',
    SA_ATTESTATION_TRUST: 'dev', // explicit: the server refuses it in production and on Base
    SA_PINNING: 'pinata',
    SA_PINATA_API_URL: ipfs.url,
    SA_PINATA_JWT: ipfs.pinKey,
    SA_IPFS_GATEWAYS: ipfs.url,
    SA_BUILDER_CONFIG: builderConfig,
    SA_BUILDER_WORK_DIR: buildsDir,
    SA_BUILDER_BUILD_ENV: ['E2E_RUNNER_TOKEN', ...passDocker].join(','),
    SA_BUILDER_SIGN_ENV: passDocker.join(','),
    SA_BUILDER_SCAN_ENV: passDocker.join(','),
    SA_CONTROL_GIT_MIRROR_DIR: repository.mirrorsDir,
    SA_CONTROL_GIT_HOSTS: new URL(repository.url).host,
    SA_CONTRACT_ADDRESS: chain.contract,
    SA_FROM_BLOCK: String(chain.fromBlock),
    SA_RPC_URL: chain.rpcUrl,
    SA_CONFIRMATIONS: '2',
    SA_DATA_DIR: path.join(workDir, 'site'),
    SA_INDEXER_POLL_MS: '300',
    SA_KEEPER_POLL_MS: '500',
    SA_KEEPER_PRIVATE_KEY: chain.keys.keeper,
    SA_KEEPER_EXPIRE: 'on',
    SA_ARCHIVE_RETRY_MS: '1000',
    SA_CONTROL_RETRY_MS: '1000',
  };
  const proc = launch('server', [process.execPath, 'src/index.js'], { cwd: path.join(APP_DIR, 'server'), env, logDir });
  try {
    await waitUntil('waiting for the server', async () => (await fetch(`${url}/health`)).ok, { timeoutMs: 60000, proc });
  } catch (err) {
    await proc.close();
    throw err;
  }
  const post = (route, body) => fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async (route) => {
    const res = await fetch(`${url}${route}`);
    return { status: res.status, json: await res.json() };
  };
  return { url, post, get, ...proc };
}

/** The production build of the client, for this run's chain, served by vite preview with /api proxied to the server. */
export async function startClient({ workDir, logDir, chain, ipfs, serverUrl }) {
  const client = path.join(APP_DIR, 'client');
  const vite = path.join(client, 'node_modules', 'vite', 'bin', 'vite.js');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    VITE_SA_CHAIN_ID: '31337',
    VITE_SA_CONTRACT: chain.contract,
    VITE_SA_RPC_URL: chain.rpcUrl,
    VITE_IPFS_GATEWAY: ipfs.url,
    SA_API_URL: serverUrl,
  };
  const dist = path.join(workDir, 'client-dist');
  must(process.execPath, [vite, 'build', '--logLevel', 'warn', '--outDir', dist, '--emptyOutDir'], { cwd: client, env });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = launch('client', [process.execPath, vite, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', dist], { cwd: client, env, logDir });
  try {
    await waitUntil('waiting for the client', async () => (await fetch(url)).ok, { timeoutMs: 60000, proc });
  } catch (err) {
    await proc.close();
    throw err;
  }
  return { url, ...proc };
}

export const newRunnerToken = () => crypto.randomBytes(32).toString('hex');
