// Test doubles for the builder's unit tests: a scripted docker CLI, a registry, a code-runner and
// an explorer that answers only from recorded responses. None of them reaches the network.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '..', 'fixtures');

export function readFixture(...parts) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
}

export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * A docker CLI double: `run(args, opts)` records the argv and answers from `script`, a function
 * (args, opts) => { exitCode, stdout, stderr } (strings or Buffers), or the default success.
 */
export function fakeDocker(script = () => ({})) {
  const calls = [];
  return {
    calls,
    async run(args, opts = {}) {
      calls.push({ args: [...args], opts });
      const r = (await script(args, opts)) || {};
      const buf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v ?? '', 'utf8'));
      return {
        exitCode: r.exitCode ?? 0,
        signal: null,
        stdout: buf(r.stdout),
        stderr: buf(r.stderr),
        stdoutTruncated: Boolean(r.stdoutTruncated),
        stderrTruncated: Boolean(r.stderrTruncated),
        timedOut: Boolean(r.timedOut),
        spawnError: r.spawnError ?? null,
      };
    },
  };
}

/** Starts an HTTP server on 127.0.0.1 with `handler(req, body) => { status, headers, body }`. */
export async function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      try {
        const out = (await handler(req, body)) || { status: 404 };
        res.writeHead(out.status ?? 200, out.headers ?? {});
        res.end(out.body === undefined ? '' : Buffer.isBuffer(out.body) ? out.body : typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const INDEX = 'application/vnd.oci.image.index.v1+json';
const CONFIG = 'application/vnd.oci.image.config.v1+json';

/**
 * Registry v2 content for an image: one manifest per platform (layer sizes given), and an index
 * when there is more than one platform. Returns the blobs by digest and the top digest.
 */
export function registryImage({ platforms = { 'linux/amd64': [1000, 2000] }, volumes = null, forceIndex = false, diffIds = [], labels = null } = {}) {
  const blobs = new Map();
  const put = (bytes, mediaType) => {
    const digest = `sha256:${sha256(bytes)}`;
    blobs.set(digest, { bytes, mediaType });
    return { mediaType, digest, size: bytes.length };
  };
  const manifests = [];
  for (const [platform, layers] of Object.entries(platforms)) {
    const [os, architecture] = platform.split('/');
    const config = put(Buffer.from(JSON.stringify({ os, architecture, config: { Env: ['PATH=/usr/bin'], ...(volumes ? { Volumes: volumes } : {}), ...(labels ? { Labels: labels } : {}) }, rootfs: { type: 'layers', diff_ids: diffIds } })), CONFIG);
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: MANIFEST,
      config,
      layers: layers.map((size, i) => ({ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${sha256(`${platform}-${i}`)}`, size })),
    }));
    manifests.push({ ...put(manifest, MANIFEST), platform: { os, architecture } });
  }
  if (manifests.length === 1 && !forceIndex) return { blobs, digest: manifests[0].digest, manifests };
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: INDEX, manifests }));
  return { blobs, digest: put(index, INDEX).digest, manifests };
}

/** A registry:2 double serving `image` under repository `name`, optionally behind an anonymous bearer token. */
export async function fakeRegistry({ name, image, token = null, tamper = null }) {
  let srv;
  srv = await startServer((req) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/token') {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: { token } };
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return {
        status: 401,
        headers: { 'www-authenticate': `Bearer realm="${srv.url}/token",service="fake",scope="repository:${name}:pull"` },
        body: { errors: [{ code: 'UNAUTHORIZED' }] },
      };
    }
    const m = /^\/v2\/(.+)\/(manifests|blobs)\/(sha256:[0-9a-f]{64})$/.exec(u.pathname);
    if (!m || m[1] !== name) return { status: 404, body: { errors: [{ code: 'NAME_UNKNOWN' }] } };
    const blob = image.blobs.get(m[3]);
    if (!blob) return { status: 404, body: { errors: [{ code: 'MANIFEST_UNKNOWN' }] } };
    const bytes = tamper ? tamper(m[3], blob.bytes) : blob.bytes;
    return { status: 200, headers: { 'content-type': blob.mediaType, 'docker-content-digest': m[3] }, body: bytes };
  });
  return srv;
}

/**
 * An explorer fetch double that answers only the recorded responses in `routes`
 * ({ getsourcecode: file, getcode: file }) and throws on anything else, so a test can never
 * reach a live explorer. Every URL it saw is in `seen`.
 */
export function recordedExplorer(routes, { apiUrl = 'https://explorer.test/api' } = {}) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    seen.push(u);
    if (`${u.origin}${u.pathname}` !== apiUrl) throw new Error(`unexpected explorer call: ${u.origin}${u.pathname}`);
    const key = u.searchParams.get('module') === 'contract' && u.searchParams.get('action') === 'getsourcecode'
      ? 'getsourcecode'
      : u.searchParams.get('module') === 'proxy' && u.searchParams.get('action') === 'eth_getCode'
        ? 'getcode'
        : null;
    if (!key || !routes[key]) throw new Error(`no recorded response for ${u.search}`);
    if (init.signal?.aborted) throw new Error('aborted');
    const text = fs.readFileSync(path.join(FIXTURES, 'explorer', routes[key]), 'utf8');
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen, apiUrl };
}

/** A code-runner double: `answer(body) => { status, body }` for POST /v1/listing-checks, bearer `token`. */
export async function fakeRunner({ token, answer }) {
  return startServer((req, body) => {
    if (req.headers.authorization !== `Bearer ${token}`) return { status: 401, body: { error: 'unauthorized' } };
    if (req.method === 'GET' && req.url === '/health') return { status: 200, body: { ok: true, version: '0.1.0' } };
    if (req.method === 'POST' && req.url === '/v1/listing-checks') {
      const out = answer(JSON.parse(body.toString('utf8')));
      return { status: out.status, headers: { 'content-type': 'application/json' }, body: out.body };
    }
    return { status: 404, body: { error: 'not found' } };
  });
}

/** Captures log lines written through the builder's logger. */
export function captureLog() {
  const lines = [];
  return { lines, write: (s) => lines.push(String(s)), text: () => lines.join('') };
}
