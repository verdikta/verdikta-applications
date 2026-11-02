// A read-only registry v2 client: an image's manifest by digest, the linux/amd64 manifest of an
// index, its config, and the compressed size an arbiter pulls. Every byte read is checked against
// the digest it was asked by, so the registry (or whatever answers for it) can only make a read
// fail, never change what the builder measures. Anonymous bearer tokens (a public GHCR image)
// are fetched as the registry's challenge asks; plain HTTP is used only for a loopback registry.
import crypto from 'node:crypto';

import { BuilderError } from './errors.js';
import { isLoopbackHost } from './net.js';

const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(', ');
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function parseChallenge(header) {
  const m = /^Bearer\s+(.*)$/i.exec(header || '');
  if (!m) return null;
  const params = {};
  for (const [, k, v] of m[1].matchAll(/([a-zA-Z]+)="([^"]*)"/g)) params[k.toLowerCase()] = v;
  return params.realm ? params : null;
}

/**
 * @param {object} o
 * @param {string} o.repository - host[:port]/path
 * @param {string|null} [o.apiUrl] - where to send the API calls, when not the repository's host
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.timeoutMs]
 */
export function createRegistryClient({ repository, apiUrl = null, fetch: fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  const slash = repository.indexOf('/');
  const host = repository.slice(0, slash);
  const name = repository.slice(slash + 1);
  let baseUrl;
  if (apiUrl) {
    const u = new URL(apiUrl);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
      throw new BuilderError('CONFIG_INVALID', 'registry.apiUrl must be https (plain http only to a loopback address)');
    }
    baseUrl = u.origin;
  } else {
    baseUrl = `${isLoopbackHost(host.replace(/:[0-9]+$/, '')) ? 'http' : 'https'}://${host}`;
  }
  let token = null;

  async function request(pathname, accept) {
    const send = () => fetchImpl(`${baseUrl}${pathname}`, {
      headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = await send();
    if (res.status === 401 && !token) {
      const challenge = parseChallenge(res.headers.get('www-authenticate'));
      if (!challenge) return res;
      const realm = new URL(challenge.realm);
      if (challenge.service) realm.searchParams.set('service', challenge.service);
      realm.searchParams.set('scope', challenge.scope || `repository:${name}:pull`);
      const t = await fetchImpl(realm, { signal: AbortSignal.timeout(timeoutMs) });
      if (t.status !== 200) return res;
      const body = await t.json();
      token = body.token || body.access_token || null;
      if (!token) return res;
      res = await send();
    }
    return res;
  }

  /** The bytes of a manifest or blob, checked against its digest. */
  async function get(kind, digest, accept, maxBytes) {
    if (!DIGEST.test(digest)) throw new BuilderError('REGISTRY_DIGEST_MISMATCH', `not a sha256 digest: ${digest}`);
    let res;
    try {
      res = await request(`/v2/${name}/${kind}/${digest}`, accept);
    } catch (err) {
      throw new BuilderError('REGISTRY_UNAVAILABLE', `${kind} ${digest}: ${err.message}`);
    }
    if (res.status !== 200) throw new BuilderError('REGISTRY_UNAVAILABLE', `${kind} ${digest}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new BuilderError('REGISTRY_UNAVAILABLE', `${kind} ${digest} is larger than ${maxBytes} bytes`);
    if (sha256(bytes) !== digest) throw new BuilderError('REGISTRY_DIGEST_MISMATCH', `the registry's ${kind} for ${digest} hashes to ${sha256(bytes)}`);
    return { bytes, mediaType: res.headers.get('content-type') || '' };
  }

  function parse(bytes, what) {
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new BuilderError('REGISTRY_UNAVAILABLE', `${what} is not JSON`);
    }
  }

  return {
    baseUrl,
    /**
     * What an arbiter pulling `digest` for `platform` gets: the platform's manifest, its config
     * and its compressed size (layers plus config), and the platforms an index offers.
     */
    async imageInfo(digest, platform) {
      const [os, architecture] = platform.split('/');
      const top = await get('manifests', digest, ACCEPT, MAX_MANIFEST_BYTES);
      const topJson = parse(top.bytes, `the manifest ${digest}`);
      const mediaType = topJson.mediaType || top.mediaType.split(';')[0];
      let manifest = topJson;
      let manifestDigest = digest;
      let platforms = null;
      if (INDEX_TYPES.has(mediaType) || Array.isArray(topJson.manifests)) {
        const entries = (topJson.manifests || []).filter((m) => m.platform && m.platform.os !== 'unknown');
        platforms = entries.map((m) => `${m.platform.os}/${m.platform.architecture}`);
        const pick = entries.find((m) => m.platform.os === os && m.platform.architecture === architecture);
        if (!pick) throw new BuilderError('IMAGE_PLATFORM_MISSING', `the image index ${digest} has no ${platform} manifest (it has ${platforms.join(', ') || 'none'})`);
        manifestDigest = pick.digest;
        manifest = parse((await get('manifests', pick.digest, ACCEPT, MAX_MANIFEST_BYTES)).bytes, `the manifest ${pick.digest}`);
      }
      if (!manifest.config || !Array.isArray(manifest.layers)) throw new BuilderError('REGISTRY_UNAVAILABLE', `${manifestDigest} is not an image manifest`);
      const config = parse((await get('blobs', manifest.config.digest, '*/*', MAX_CONFIG_BYTES)).bytes, `the config ${manifest.config.digest}`);
      if (config.os !== os || config.architecture !== architecture) {
        throw new BuilderError('IMAGE_PLATFORM_MISSING', `the image ${digest} is ${config.os}/${config.architecture}, not ${platform}`);
      }
      const sizes = [manifest.config.size, ...manifest.layers.map((l) => l.size)];
      if (!sizes.every((s) => Number.isSafeInteger(s) && s >= 0)) throw new BuilderError('REGISTRY_UNAVAILABLE', `${manifestDigest} lists a size that is not a byte count`);
      return {
        digest,
        manifestDigest,
        compressedBytes: sizes.reduce((a, b) => a + b, 0),
        platforms: platforms ?? [`${config.os}/${config.architecture}`],
        config: { os: config.os, architecture: config.architecture },
        volumes: Object.keys((config.config && config.config.Volumes) || {}),
      };
    },
  };
}
