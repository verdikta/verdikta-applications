#!/usr/bin/env node
// How the reusable builder workflow moves the env image: out of the build job's loopback
// registry, through an artifact, into the published repository, byte for byte. skopeo (pinned by
// digest in pins.json, run as a container) copies it with --preserve-digests into its `dir:`
// layout, which keeps any manifest type as it is; `docker push` writes Docker schema-2
// manifests, which skopeo's `oci:` layout stores but will not read back by name. Before a push,
// the layout is checked: its top manifest is the digest code_review.json names, and every
// manifest and blob under it has the bytes its digest and size say.
//
//   node action/image.js export  --from <host/repo@sha256:…> --dir <dir>
//   node action/image.js verify  --dir <dir> --digest sha256:<hex>
//   node action/image.js publish --dir <dir> --image <repository@sha256:…> --to <repository>
//
// publish reads the registry credential from REGISTRY_USER and REGISTRY_TOKEN and hands it to
// skopeo in an auth file of its own (owner-only, removed after), never on a command line; then it
// reads the pushed image back without a credential, as arbiters pull it.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dockerEnv } from '../src/docker.js';
import { BuilderError } from '../src/errors.js';
import { neutralize } from '../src/logSafe.js';
import { isLoopbackHost } from '../src/net.js';

const PINS = JSON.parse(fs.readFileSync(new URL('./pins.json', import.meta.url), 'utf8'));
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^([^@\s]+)@(sha256:[0-9a-f]{64})$/;
const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function bad(code, detail) {
  return new BuilderError(code, detail);
}

const hostOf = (repository) => repository.slice(0, repository.indexOf('/'));
const loopback = (repository) => isLoopbackHost(hostOf(repository).replace(/:[0-9]+$/, ''));

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    h.update(chunk);
    size += chunk.length;
  }
  return { digest: `sha256:${h.digest('hex')}`, size };
}

/**
 * Checks a skopeo `dir:` layout: `manifest.json` is the image at `digest`, an index's manifests
 * are `<hex>.manifest.json`, and every config and layer is `<hex>`, each with the bytes its
 * descriptor's digest and size say.
 * @returns {Promise<{ digest: string, blobs: number }>}
 * @throws {BuilderError} IMAGE_DIR_INVALID, IMAGE_DIGEST_MISMATCH, IMAGE_BLOB_CORRUPT
 */
export async function verifyImageDir({ dir, digest }) {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw bad('IMAGE_DIGEST_MISMATCH', `not a sha256 digest: ${digest}`);
  let version = '';
  try {
    version = fs.readFileSync(path.join(dir, 'version'), 'utf8');
  } catch {
    /* reported below */
  }
  if (!/^Directory Transport Version: 1\.[0-9]+\n?$/.test(version)) throw bad('IMAGE_DIR_INVALID', `${dir} is not a skopeo dir: layout`);
  const seen = new Set();
  const readManifest = async (file, desc) => {
    let got;
    try {
      got = await hashFile(file);
    } catch {
      throw bad('IMAGE_BLOB_CORRUPT', `the manifest ${desc.digest} is missing from the layout`);
    }
    if (got.digest !== desc.digest || (desc.size !== undefined && got.size !== desc.size)) {
      throw bad(desc.top ? 'IMAGE_DIGEST_MISMATCH' : 'IMAGE_BLOB_CORRUPT', `the layout's manifest is ${got.digest}, not ${desc.digest}`);
    }
    if (got.size > MAX_JSON_BYTES) throw bad('IMAGE_DIR_INVALID', `the manifest ${desc.digest} is too large`);
    seen.add(desc.digest);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw bad('IMAGE_DIR_INVALID', `the manifest ${desc.digest} is not JSON`);
    }
  };
  const blob = async (desc) => {
    if (!desc || !DIGEST.test(String(desc.digest)) || !Number.isSafeInteger(desc.size) || desc.size < 0) throw bad('IMAGE_DIR_INVALID', 'a descriptor without a sha256 digest and a size');
    if (seen.has(desc.digest)) return;
    let got;
    try {
      got = await hashFile(path.join(dir, desc.digest.slice('sha256:'.length)));
    } catch {
      throw bad('IMAGE_BLOB_CORRUPT', `${desc.digest} is missing from the layout`);
    }
    if (got.digest !== desc.digest || got.size !== desc.size) throw bad('IMAGE_BLOB_CORRUPT', `${desc.digest} holds ${got.size} bytes hashing to ${got.digest}`);
    seen.add(desc.digest);
  };
  const image = async (m) => {
    await blob(m.config);
    for (const l of m.layers ?? []) await blob(l);
  };
  const top = await readManifest(path.join(dir, 'manifest.json'), { digest, top: true });
  if (INDEX_TYPES.has(top.mediaType) || Array.isArray(top.manifests)) {
    for (const d of top.manifests ?? []) {
      if (!d || !DIGEST.test(String(d.digest)) || !Number.isSafeInteger(d.size)) throw bad('IMAGE_DIR_INVALID', 'an index entry without a sha256 digest and a size');
      if (INDEX_TYPES.has(d.mediaType)) throw bad('IMAGE_DIR_INVALID', 'a nested index');
      await image(await readManifest(path.join(dir, `${d.digest.slice('sha256:'.length)}.manifest.json`), d));
    }
  } else {
    await image(top);
  }
  return { digest, blobs: seen.size };
}

/** `docker run` of the pinned skopeo as the calling user, on the host network, with `mounts`. */
export function skopeoRun({ mounts, args, uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0 }) {
  return [
    'run', '--rm', '--network', 'host', '--user', `${uid}:${gid}`, '--env', 'HOME=/tmp',
    ...mounts.flatMap(([src, dst, mode]) => ['--volume', `${src}:${dst}:${mode}`]),
    PINS.skopeo.image,
    ...args,
  ];
}

/** skopeo's arguments to export `from` (repository@digest) into the layout at /image. */
export function exportArgs(from) {
  const m = REF.exec(from);
  if (!m) throw new TypeError('the image to export must be named by digest');
  return ['copy', '--quiet', '--all', '--preserve-digests', ...(loopback(m[1]) ? ['--src-tls-verify=false'] : []), `docker://${from}`, 'dir:/image'];
}

/** skopeo's arguments to push the layout at /image to `to`, keeping every digest. */
export function publishArgs({ digest, to, authfile }) {
  const tag = `listing-${digest.slice('sha256:'.length)}`;
  return ['copy', '--quiet', '--all', '--preserve-digests', ...(authfile ? ['--dest-authfile', authfile] : []), ...(loopback(to) ? ['--dest-tls-verify=false'] : []), 'dir:/image', `docker://${to}:${tag}`];
}

/** skopeo's arguments to read `ref`'s top manifest as published, with no credential. */
export function inspectArgs(ref) {
  const m = REF.exec(ref);
  if (!m) throw new TypeError('the image to read must be named by digest');
  return ['inspect', '--raw', '--no-creds', ...(loopback(m[1]) ? ['--tls-verify=false'] : []), `docker://${ref}`];
}

/** Runs the docker CLI; `what` names the step in an error. */
function docker(args, what) {
  // The docker CLI's allow-listed environment: never the registry token, which reaches skopeo only in its auth file.
  const r = spawnSync('docker', args, { env: dockerEnv(), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw bad('IMAGE_COPY_FAILED', `${what} failed: ${String(r.stderr || r.error?.message || '').slice(-1500).trim()}`);
  return r.stdout;
}

export async function exportImage({ from, dir }) {
  const m = REF.exec(from);
  if (!m) throw new TypeError('the image to export must be named by digest');
  fs.mkdirSync(dir, { recursive: true });
  docker(skopeoRun({ mounts: [[path.resolve(dir), '/image', 'rw']], args: exportArgs(from) }), `the export of ${from}`);
  return verifyImageDir({ dir, digest: m[2] });
}

export async function publishImage({ dir, image, to, env = process.env }) {
  const m = REF.exec(image);
  if (!m) throw new TypeError('--image must be the repository@digest code_review.json names');
  if (m[1] !== to) throw bad('IMAGE_NOT_FOR_THIS_REPOSITORY', `code_review.json names ${image}, not an image in ${to}`);
  const digest = m[2];
  await verifyImageDir({ dir, digest });
  const auth = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'vab-auth-'));
  try {
    let authfile = null;
    if (env.REGISTRY_USER && env.REGISTRY_TOKEN) {
      fs.writeFileSync(path.join(auth, 'auth.json'), JSON.stringify({ auths: { [hostOf(to)]: { auth: Buffer.from(`${env.REGISTRY_USER}:${env.REGISTRY_TOKEN}`).toString('base64') } } }), { mode: 0o600 });
      authfile = '/auth/auth.json';
    }
    docker(skopeoRun({ mounts: [[path.resolve(dir), '/image', 'ro'], ...(authfile ? [[auth, '/auth', 'ro']] : [])], args: publishArgs({ digest, to, authfile }) }), `the push to ${to}`);
  } finally {
    fs.rmSync(auth, { recursive: true, force: true });
  }
  const raw = docker(skopeoRun({ mounts: [], args: inspectArgs(image) }), `reading ${image} back without a credential`);
  const served = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
  if (served !== digest) throw bad('IMAGE_NOT_PUBLISHED', `${to} serves ${served} for ${digest}`);
  return { digest, to };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) opts[String(rest[i]).replace(/^--/, '')] = rest[i + 1];
  try {
    if (command === 'export' && opts.from && opts.dir) {
      const r = await exportImage({ from: opts.from, dir: opts.dir });
      process.stdout.write(`exported ${r.digest} (${r.blobs} manifests and blobs)\n`);
    } else if (command === 'verify' && opts.dir && opts.digest) {
      const r = await verifyImageDir({ dir: opts.dir, digest: opts.digest });
      process.stdout.write(`verified ${r.digest} (${r.blobs} manifests and blobs)\n`);
    } else if (command === 'publish' && opts.dir && opts.image && opts.to) {
      const r = await publishImage({ dir: opts.dir, image: opts.image, to: opts.to });
      process.stdout.write(`published ${r.to}@${r.digest}, readable without a credential\n`);
    } else {
      process.stderr.write('usage: node action/image.js export --from <repo@sha256:…> --dir <dir>\n'
        + '       node action/image.js verify --dir <dir> --digest sha256:<hex>\n'
        + '       node action/image.js publish --dir <dir> --image <repository@sha256:…> --to <repository>\n');
      return 64;
    }
    return 0;
  } catch (err) {
    process.stderr.write(neutralize(`image: ${err.message}\n`));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
