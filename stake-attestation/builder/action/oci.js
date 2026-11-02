#!/usr/bin/env node
// The reusable builder workflow hands the env image from the build job to the publish job as an
// OCI image layout (skopeo's `oci:` format). Before anything is pushed, this checks that the
// layout holds exactly the image the build validated: one top-level entry, at the digest
// code_review.json names, and every blob under it present with the bytes its digest and size say.
//
//   node action/oci.js verify --dir <layout> --digest sha256:<hex>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BuilderError } from '../src/errors.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function bad(code, detail) {
  return new BuilderError(code, detail);
}

function readJson(file, what) {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_JSON_BYTES) throw new Error('too large');
    return { bytes, json: JSON.parse(bytes.toString('utf8')) };
  } catch (err) {
    throw bad('OCI_LAYOUT_INVALID', `${what}: ${err.message}`);
  }
}

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
 * @param {{ dir: string, digest: string }} o
 * @returns {Promise<{ digest: string, blobs: number }>}
 * @throws {BuilderError} OCI_LAYOUT_INVALID, OCI_DIGEST_MISMATCH, OCI_BLOB_CORRUPT
 */
export async function verifyOciLayout({ dir, digest }) {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw bad('OCI_DIGEST_MISMATCH', `not a sha256 digest: ${digest}`);
  const layout = readJson(path.join(dir, 'oci-layout'), 'oci-layout').json;
  if (layout.imageLayoutVersion !== '1.0.0') throw bad('OCI_LAYOUT_INVALID', `imageLayoutVersion ${layout.imageLayoutVersion}`);
  const index = readJson(path.join(dir, 'index.json'), 'index.json').json;
  const tops = Array.isArray(index.manifests) ? index.manifests : [];
  if (tops.length !== 1 || tops[0].digest !== digest) {
    throw bad('OCI_DIGEST_MISMATCH', `the layout holds ${tops.map((m) => m.digest).join(', ') || 'nothing'}, not exactly ${digest}`);
  }
  const seen = new Set();
  async function verify(desc, depth) {
    if (!desc || !DIGEST.test(String(desc.digest)) || !Number.isSafeInteger(desc.size) || desc.size < 0) throw bad('OCI_LAYOUT_INVALID', 'a descriptor without a sha256 digest and a size');
    if (depth > 4) throw bad('OCI_LAYOUT_INVALID', 'indexes nest too deep');
    const file = path.join(dir, 'blobs', 'sha256', desc.digest.slice('sha256:'.length));
    let got;
    try {
      got = await hashFile(file);
    } catch {
      throw bad('OCI_BLOB_CORRUPT', `${desc.digest} is missing from the layout`);
    }
    if (got.digest !== desc.digest || got.size !== desc.size) throw bad('OCI_BLOB_CORRUPT', `${desc.digest} holds ${got.size} bytes hashing to ${got.digest}`);
    if (seen.has(desc.digest)) return;
    seen.add(desc.digest);
    if (!INDEX_TYPES.has(desc.mediaType) && !MANIFEST_TYPES.has(desc.mediaType)) return;
    const { json } = readJson(file, desc.digest);
    if (INDEX_TYPES.has(desc.mediaType)) {
      for (const m of json.manifests ?? []) await verify(m, depth + 1);
    } else {
      await verify(json.config, depth + 1);
      for (const l of json.layers ?? []) await verify(l, depth + 1);
    }
  }
  await verify(tops[0], 0);
  return { digest, blobs: seen.size };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) opts[String(rest[i]).replace(/^--/, '')] = rest[i + 1];
  if (command !== 'verify' || !opts.dir || !opts.digest) {
    process.stderr.write('usage: node action/oci.js verify --dir <layout> --digest sha256:<hex>\n');
    return 64;
  }
  try {
    const r = await verifyOciLayout({ dir: opts.dir, digest: opts.digest });
    process.stdout.write(`verified ${r.digest} (${r.blobs} blobs)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`oci: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
