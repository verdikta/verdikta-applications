// The deploy kit (node P23; README "Running the site"): the site at https://verifiers.verdikta.org on one Linux host,
// nginx in front of the server. These hold the kit's files to the rules the README states: the headers in one include
// file, a Content-Security-Policy with exactly the client's own sources, the rate limits sized from the client's own
// polling, the body and time limits from the server's, certbot's paths, and no host detail anywhere.
// The env template is held to the server's config by server/test/deployEnv.test.js, the scan's builder config by
// builder/test/unit/deployKit.test.js, the policy against the built client by client/playwright.csp.config.js, and
// the site config against a real nginx by the CI job that runs nginx -t (test/deploy/nginxLive.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseCsp, parseEnvFile, parseHeaderInclude, parseNginx } from '../../src/deployKit.js';
import { APP_DIR } from './helpers.js';

// The client's own reader of VITE_IPFS_GATEWAY, so these tests read the list as the build does.
const { parseGateways } = await import(pathToFileURL(path.join(APP_DIR, 'client', 'src', 'config.js')).href);

const DEPLOY = path.join(APP_DIR, 'deploy');
const read = (rel) => fs.readFileSync(path.join(DEPLOY, rel), 'utf8');
const SITE = 'verifiers.verdikta.org';
const FILES = {
  site: `nginx/${SITE}.conf`,
  headers: `nginx/${SITE}-headers.conf`,
  unit: 'systemd/verdikta-verifiers.service',
  delegate: 'systemd/user@.service.d/delegate.conf',
  serverEnv: 'server.env.example',
  clientEnv: 'client.env',
  builder: 'builder.json',
  scanCheck: 'check-scan-limits.mjs',
};
// Where the host keeps them (README "Running the site").
const HEADERS_PATH = `/etc/nginx/snippets/${SITE}-headers.conf`;
const WEB_ROOT = `/var/www/${SITE}`;
const ACME_ROOT = '/var/www/html';

test('deploy/ holds the kit', () => {
  for (const f of Object.values(FILES)) assert.ok(fs.existsSync(path.join(DEPLOY, f)), `deploy/${f}`);
  assert.equal(fs.existsSync(path.join(DEPLOY, 'package.json')), false, 'deploy/ is files, not a package');
});

// ---------------------------------------------------------------------------------------------- headers

const headers = () => parseHeaderInclude(read(FILES.headers));
const header = (name) => {
  const h = headers().find((x) => x.name.toLowerCase() === name.toLowerCase());
  assert.ok(h, `${FILES.headers}: ${name}`);
  return h;
};
const csp = () => new Map(parseCsp(header('Content-Security-Policy').value));
const origin = (u) => new URL(u).origin;

test('the include file sets the CSP, HSTS, X-Content-Type-Options, Referrer-Policy and Permissions-Policy, each on every answer (always)', () => {
  const names = headers().map((h) => h.name).sort();
  assert.deepEqual(names, ['Content-Security-Policy', 'Permissions-Policy', 'Referrer-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options']);
  for (const h of headers()) assert.equal(h.always, true, `${h.name}: always, so a 404 or a 429 carries it too`);
  assert.equal(header('X-Content-Type-Options').value, 'nosniff');
  assert.equal(header('Referrer-Policy').value, 'no-referrer');
});

test('HSTS: at least a year, this host only, no preload', () => {
  const v = header('Strict-Transport-Security').value;
  const age = /^max-age=(\d+)$/.exec(v);
  assert.ok(age, `HSTS is max-age alone (no includeSubDomains: the other subdomains are not the site's; no preload): ${v}`);
  assert.ok(Number(age[1]) >= 31536000, v);
});

test('Permissions-Policy denies every feature it names, among them the ones a site like this could be asked for', () => {
  const entries = header('Permissions-Policy').value.split(',').map((s) => s.trim());
  for (const e of entries) assert.match(e, /^[a-z-]+=\(\)$/, `${e}: denied, with no origin`);
  const features = entries.map((e) => e.split('=')[0]);
  for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'hid', 'clipboard-read', 'display-capture']) {
    assert.ok(features.includes(f), f);
  }
  assert.equal(new Set(features).size, features.length, 'each feature once');
});

test('the CSP: nothing by default, the site\'s own script, style and images, no frames, no base, no plugins, no form posts', () => {
  const p = csp();
  assert.deepEqual(p.get('default-src'), ["'none'"]);
  assert.deepEqual(p.get('script-src'), ["'self'"]);
  assert.deepEqual(p.get('style-src'), ["'self'"]);
  assert.deepEqual(p.get('img-src'), ["'self'"]);
  assert.deepEqual(p.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(p.get('object-src'), ["'none'"]);
  assert.deepEqual(p.get('form-action'), ["'none'"]);
  assert.ok(["'none'", "'self'"].includes(p.get('base-uri')?.join(' ')), 'base-uri none or self');
  assert.equal(p.has('report-uri') || p.has('report-to'), false, 'no reporting endpoint: the test adds its own');
});

test('the CSP has no unsafe source, nonce, hash, wildcard or scheme-only source, and every host source is an exact https origin', () => {
  for (const [directive, sources] of csp()) {
    for (const s of sources) {
      assert.doesNotMatch(s, /unsafe|strict-dynamic|^'nonce-|^'sha(256|384|512)-/i, `${directive} ${s}`);
      assert.doesNotMatch(s, /\*/, `${directive} ${s}: no wildcard`);
      assert.doesNotMatch(s, /^[a-z][a-z0-9+.-]*:$/i, `${directive} ${s}: no scheme-only source`);
      if (s.startsWith("'")) {
        assert.ok(["'self'", "'none'"].includes(s), `${directive} ${s}`);
        continue;
      }
      assert.equal(s, origin(s), `${directive} ${s}: an origin, no path`);
      assert.match(s, /^https:\/\//, `${directive} ${s}: https`);
    }
  }
});

// The client's off-origin calls are its build's: VITE_SA_RPC_URL (chain reads) and the gateways of VITE_IPFS_GATEWAY
// (the disclosed ciphertext on the check page, a comma-separated list asked in order). Everything else is /api on the
// same origin.
const clientEnv = () => parseEnvFile(read(FILES.clientEnv));
const gatewaysOf = (env) => env.get('VITE_IPFS_GATEWAY').split(',');

test('client.env builds the client for Base Sepolia, with a public RPC endpoint and gateways that carry no key', () => {
  const env = clientEnv();
  const configJs = fs.readFileSync(path.join(APP_DIR, 'client', 'src', 'config.js'), 'utf8');
  const read = [...new Set([...configJs.matchAll(/env\.(VITE_[A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual([...env.keys()].sort(), read, 'client.env names exactly the variables client/src/config.js reads');
  assert.equal(env.get('VITE_SA_CHAIN_ID'), '84532');
  assert.equal(env.get('VITE_SA_CONTRACT'), '', 'per deployment: from the deployment JSON');
  const urls = [['VITE_SA_RPC_URL', env.get('VITE_SA_RPC_URL')], ...gatewaysOf(env).map((g) => ['VITE_IPFS_GATEWAY', g])];
  for (const [name, value] of urls) {
    assert.equal(value, value.trim(), `${name}: ${value}, no spaces`);
    const u = new URL(value);
    assert.equal(u.protocol, 'https:', `${name}: ${value}`);
    assert.equal(`${u.username}${u.password}${u.search}${u.hash}`, '', `${name}: everything in the build is public, so no key in it`);
    assert.ok(['', '/'].includes(u.pathname), `${name}: ${value}, an origin (a key would sit in the path)`);
  }
});

test('VITE_IPFS_GATEWAY is a list the client reads whole: every entry an origin it asks, each once, in the file\'s order', () => {
  const env = clientEnv();
  const listed = gatewaysOf(env);
  assert.ok(listed.length >= 1, 'at least one gateway');
  assert.deepEqual(parseGateways(env.get('VITE_IPFS_GATEWAY')), listed.map(origin), 'the client leaves none out and keeps the order');
  assert.equal(new Set(listed.map(origin)).size, listed.length, 'no gateway twice');
});

test('connect-src is exactly the site, the client\'s RPC endpoint and each of its gateways, in client.env\'s order', () => {
  const env = clientEnv();
  assert.deepEqual(csp().get('connect-src'), ["'self'", origin(env.get('VITE_SA_RPC_URL')), ...gatewaysOf(env).map(origin)]);
});

// ---------------------------------------------------------------------------------------------- the site config

const tree = () => parseNginx(read(FILES.site));
const all = (nodes, name, out = []) => {
  for (const n of nodes) {
    if (n.name === name) out.push(n);
    if (n.block) all(n.block, name, out);
  }
  return out;
};
const one = (nodes, name) => {
  const found = (nodes ?? []).filter((n) => n.name === name);
  assert.equal(found.length, 1, `exactly one ${name}`);
  return found[0];
};
const servers = () => tree().filter((n) => n.name === 'server');
const siteServer = (port) => {
  const s = servers().filter((x) => x.block.some((d) => d.name === 'server_name' && d.args.includes(SITE)) && x.block.some((d) => d.name === 'listen' && d.args[0] === String(port)));
  assert.equal(s.length, 1, `one server for ${SITE} on ${port}`);
  return s[0];
};
const location = (server, ...args) => {
  const l = server.block.filter((d) => d.name === 'location' && d.args.join(' ') === args.join(' '));
  assert.equal(l.length, 1, `location ${args.join(' ')}`);
  return l[0];
};

test('the site config names only verifiers.verdikta.org, and anything addressed otherwise gets nothing', () => {
  const names = all(tree(), 'server_name').flatMap((d) => d.args);
  assert.deepEqual([...new Set(names)].sort(), ['_', SITE]);
  const catchAll = servers().filter((s) => s.block.some((d) => d.name === 'server_name' && d.args[0] === '_'));
  assert.equal(catchAll.length, 2, 'a default server on 80 and on 443');
  for (const s of catchAll) {
    assert.ok(s.block.some((d) => d.name === 'listen' && d.args.includes('default_server')));
    assert.ok(s.block.some((d) => (d.name === 'return' && d.args[0] === '444') || (d.name === 'ssl_reject_handshake' && d.args[0] === 'on')));
  }
});

test('HTTP answers certbot\'s challenge from its webroot and sends everything else to HTTPS', () => {
  const http = siteServer(80);
  const acme = location(http, '^~', '/.well-known/acme-challenge/');
  assert.deepEqual(one(acme.block, 'root').args, [ACME_ROOT]);
  assert.deepEqual(one(location(http, '/').block, 'return').args, ['301', `https://${SITE}$request_uri`]);
});

test('HTTPS: certbot\'s certificate paths, TLS 1.2 and 1.3 only, the include file once at server level and no add_header anywhere else', () => {
  const https = siteServer(443);
  assert.ok(https.block.some((d) => d.name === 'listen' && d.args.includes('ssl')));
  assert.deepEqual(one(https.block, 'ssl_certificate').args, [`/etc/letsencrypt/live/${SITE}/fullchain.pem`]);
  assert.deepEqual(one(https.block, 'ssl_certificate_key').args, [`/etc/letsencrypt/live/${SITE}/privkey.pem`]);
  assert.deepEqual(one(https.block, 'ssl_protocols').args, ['TLSv1.2', 'TLSv1.3']);
  assert.deepEqual(all(tree(), 'include').map((d) => d.args), [[HEADERS_PATH]]);
  assert.ok(https.block.some((d) => d.name === 'include'), 'included in the HTTPS server itself, so every location inherits it');
  // nginx inherits add_header only into a block with none of its own: one more would silently drop the include's
  assert.deepEqual(all(tree(), 'add_header'), []);
  assert.deepEqual(one(https.block, 'server_tokens').args, ['off']);
});

test('HTTPS serves the client\'s build from its web root: index.html never cached, the hashed assets for good', () => {
  const https = siteServer(443);
  assert.deepEqual(one(https.block, 'root').args, [WEB_ROOT]);
  assert.deepEqual(one(location(https, '=', '/index.html').block, 'expires').args, ['-1']);
  assert.deepEqual(one(location(https, '/assets/').block, 'expires').args, ['max']);
});

// Node P27: the agents' documents come with the client's build (client/public, which Vite copies to the build's root).
// nginx names text/plain without a charset, so each has an exact location that adds charset utf-8 and nothing else:
// no add_header (the include's headers stay inherited), no other type, the same web root.
test('HTTPS serves /agents.txt and /llms.txt from the web root as UTF-8: an exact location each, with charset utf-8 alone', () => {
  const https = siteServer(443);
  for (const name of ['agents.txt', 'llms.txt']) {
    assert.ok(fs.existsSync(path.join(APP_DIR, 'client', 'public', name)), `client/public/${name}`);
    const l = location(https, '=', `/${name}`);
    assert.deepEqual(l.block.map((d) => [d.name, ...d.args]), [['charset', 'utf-8']], `location = /${name}`);
  }
  assert.equal(all(tree(), 'charset').length, 2, 'charset only there');
});

const upstreams = () => tree().filter((n) => n.name === 'upstream');

test('/api goes to the server on 127.0.0.1:5009, and nowhere else is proxied', () => {
  const up = upstreams();
  assert.equal(up.length, 1);
  assert.deepEqual(one(up[0].block, 'server').args, ['127.0.0.1:5009']);
  const passes = all(tree(), 'proxy_pass').map((d) => d.args[0]);
  assert.ok(passes.length >= 1);
  for (const p of passes) assert.equal(p, `http://${up[0].args[0]}`);
  const https = siteServer(443);
  const proxied = https.block.filter((d) => d.name === 'location' && d.block.some((x) => x.name === 'proxy_pass')).map((d) => d.args.join(' '));
  for (const l of proxied) assert.match(l, /^(?:= |~\*? \^)?\/api\//, `${l}: only /api is proxied`);
  assert.ok(proxied.includes('/api/'));
});

// ---------------------------------------------------------------------------------------------- limits

const SIZE = /^(\d+)([km]?)$/i;
const bytesOf = (v) => {
  const m = SIZE.exec(v);
  assert.ok(m, `a size: ${v}`);
  return Number(m[1]) * { '': 1, k: 1024, m: 1024 * 1024 }[m[2].toLowerCase()];
};
// express's limits ('1mb', '32kb') are bytes in base 1024, as nginx's
const expressBytes = (v) => {
  const m = /^(\d+)(kb|mb)$/.exec(v);
  assert.ok(m, v);
  return Number(m[1]) * (m[2] === 'kb' ? 1024 : 1024 * 1024);
};
const serverConst = (file, name) => {
  const m = new RegExp(`const ${name} = '([^']+)'`).exec(fs.readFileSync(path.join(APP_DIR, 'server', 'src', file), 'utf8'));
  assert.ok(m, `${file}: ${name}`);
  return m[1];
};
const bodyLimit = (loc) => bytesOf(one(loc.block, 'client_max_body_size').args[0]);
// The listing routes' location: a case-insensitive regex, as Express routes them (server/test/deployEnv.test.js holds
// it and the build zone's map to the server's own routing).
const LISTING_LOCATION = '^/api/listings(?:/challenge)?/?$';
const listingLocation = (server) => location(server, '~*', LISTING_LOCATION);
const nginxRegex = (pattern) => {
  const m = /^~(\*?)(.*)$/.exec(pattern);
  assert.ok(m, `a regex: ${pattern}`);
  return new RegExp(m[2], m[1] ? 'i' : '');
};

test('the listing routes\' location takes the submission and its challenge in each spelling the server routes, and nothing else', () => {
  const re = nginxRegex(`~*${LISTING_LOCATION}`);
  for (const p of ['/api/listings', '/api/listings/', '/api/LISTINGS', '/api/Listings/Challenge', '/api/listings/challenge/']) assert.ok(re.test(p), p);
  for (const p of [`/api/listings/${'a'.repeat(32)}`, '/api/listings/x/scan', '/api/listingsx', '/api/listings/challenge/x']) assert.equal(re.test(p), false, p);
});

test('body limits: the listing routes take the server\'s 1 MB and more, every other /api route the largest of the rest, so the server answers its own 413', () => {
  const https = siteServer(443);
  const listing = expressBytes(serverConst('app.js', 'BODY_LIMIT'));
  const l = listingLocation(https);
  assert.ok(bodyLimit(l) > listing, `${l.args.join(' ')}: above the server's ${listing}`);
  assert.ok(bodyLimit(l) <= 4 * listing, `${l.args.join(' ')}: not far above it`);
  const others = Math.max(...[['app.js', 'AUTH_BODY_LIMIT'], ['app.js', 'PROOF_BODY_LIMIT'], ['dispute/statement.js', 'BODY_LIMIT']].map(([f, n]) => expressBytes(serverConst(f, n))));
  const api = bodyLimit(location(https, '/api/'));
  assert.ok(api > others && api < listing, `/api/: above ${others}, below ${listing}`);
});

const seconds = (v) => {
  const m = /^(\d+)(s|m)?$/.exec(v);
  assert.ok(m, v);
  return Number(m[1]) * (m[2] === 'm' ? 60 : 1);
};

test('the proxy waits longer than the slowest answer the server gives: a dispute statement\'s pin (SA_PIN_TIMEOUT_MS)', () => {
  const https = siteServer(443);
  const pinMs = Number(/SA_PIN_TIMEOUT_MS',\s*(\d+)/.exec(fs.readFileSync(path.join(APP_DIR, 'server', 'src', 'config.js'), 'utf8'))[1]);
  assert.ok(seconds(one(https.block, 'proxy_read_timeout').args[0]) * 1000 >= 2 * pinMs);
  assert.ok(seconds(one(https.block, 'proxy_connect_timeout').args[0]) <= 10);
  for (const name of ['client_body_timeout', 'client_header_timeout', 'send_timeout']) assert.ok(one(https.block, name), name);
});

const zones = () => new Map(tree().filter((n) => n.name === 'limit_req_zone').map((n) => {
  const zone = n.args.find((a) => a.startsWith('zone=')).slice(5).split(':')[0];
  const rate = n.args.find((a) => a.startsWith('rate=')).slice(5);
  return [zone, { key: n.args[0], rate }];
}));
const perSecond = (rate) => {
  const m = /^(\d+)r\/(s|m)$/.exec(rate);
  assert.ok(m, rate);
  return Number(m[1]) / (m[2] === 'm' ? 60 : 1);
};
const limits = (loc) => new Map(loc.block.filter((d) => d.name === 'limit_req').map((d) => {
  const zone = d.args.find((a) => a.startsWith('zone=')).slice(5);
  const burst = Number((d.args.find((a) => a.startsWith('burst=')) ?? 'burst=0').slice(6));
  assert.ok(d.args.includes('nodelay'), `${zone}: nodelay, so a request inside the burst is never held back`);
  return [zone, burst];
}));

const maps = () => new Map(tree().filter((n) => n.name === 'map').map((n) => [n.args[1], { source: n.args[0], entries: n.block.map((d) => [d.name, ...d.args]) }]));

test('three zones per client address: every /api request, every POST under /api, and a listing submission in any spelling', () => {
  const z = zones();
  assert.equal(z.size, 3);
  const m = maps();
  assert.equal(m.size, 2);
  const [postKey, post] = [...m].find(([, v]) => v.source === '$request_method');
  assert.deepEqual(post.entries, [['POST', '$binary_remote_addr'], ['default', '']], 'only a POST is counted in the work zone');
  const [buildKey, build] = [...m].find(([, v]) => v.source === '$request_method $uri');
  assert.equal(build.entries.length, 2);
  assert.deepEqual(build.entries[1], ['default', '']);
  assert.equal(build.entries[0][1], '$binary_remote_addr');
  const re = nginxRegex(build.entries[0][0]);
  for (const r of ['POST /api/listings', 'POST /api/listings/', 'POST /api/LISTINGS', 'POST /api/Listings/']) assert.ok(re.test(r), r);
  for (const r of ['GET /api/listings', 'POST /api/listings/challenge', `POST /api/listings/${'a'.repeat(32)}/scan`, 'POST /api/listingsx']) assert.equal(re.test(r), false, r);
  assert.deepEqual([...z.values()].map((x) => x.key).sort(), ['$binary_remote_addr', buildKey, postKey].sort());
  assert.deepEqual(all(tree(), 'limit_req_status').map((d) => d.args), [['429']]);
});

test('every proxied location takes all three zones with the same bursts, each zone stricter than the last', () => {
  const https = siteServer(443);
  const z = zones();
  const m = maps();
  const keyOf = (source) => [...m].find(([, v]) => v.source === source)[0];
  const zoneOf = (key) => [...z].find(([, v]) => v.key === key)[0];
  const [general, work, build] = [zoneOf('$binary_remote_addr'), zoneOf(keyOf('$request_method')), zoneOf(keyOf('$request_method $uri'))];
  const api = limits(location(https, '/api/'));
  assert.deepEqual([...api.keys()].sort(), [build, general, work].sort());
  // a proxied location without the zones would be unlimited, and nginx takes a regex location over /api/
  const proxied = https.block.filter((d) => d.name === 'location' && d.block.some((x) => x.name === 'proxy_pass'));
  assert.equal(proxied.length, 2);
  for (const l of proxied) assert.deepEqual([...limits(l)], [...api], `${l.args.join(' ')}: the same zones and bursts`);
  assert.ok(perSecond(z.get(work).rate) < perSecond(z.get(general).rate));
  assert.ok(perSecond(z.get(build).rate) < perSecond(z.get(work).rate));
  assert.ok(api.get(build) < api.get(work));
});

test('the general zone leaves room for the client\'s own polling of GET /api/listings/:id, twice over', () => {
  const api = fs.readFileSync(path.join(APP_DIR, 'client', 'src', 'lib', 'api.js'), 'utf8');
  const m = /export async function followListing\(id, onView, \{ intervalMs = (\d+), maxIntervalMs = (\d+)/.exec(api);
  assert.ok(m, 'client/src/lib/api.js: followListing\'s intervals');
  const fastest = 1000 / Number(m[1]);
  const z = zones();
  const general = [...z].find(([, v]) => v.key === '$binary_remote_addr')[0];
  assert.ok(perSecond(z.get(general).rate) >= 2 * fastest, `${z.get(general).rate} against ${fastest} a second, the client's fastest poll`);
  assert.ok(limits(location(siteServer(443), '/api/')).get(general) >= 10, 'a burst for a page load in several tabs');
});

// ---------------------------------------------------------------------------------------------- the service

const unit = () => {
  const out = new Map();
  for (const line of read(FILES.unit).split('\n')) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1], [...(out.get(m[1]) ?? []), m[2]]);
  }
  return out;
};

test('the unit runs the server as an unprivileged user, with its environment in a file outside the repository, restarted on failure', () => {
  const u = unit();
  const user = u.get('User')?.[0];
  assert.ok(user && user !== 'root' && user !== '0');
  assert.equal(u.has('SupplementaryGroups'), false, 'no docker group: rootless Docker is the user\'s own');
  assert.deepEqual(u.get('Restart'), ['on-failure']);
  assert.deepEqual(u.get('NoNewPrivileges'), ['yes']);
  const [envFile] = u.get('EnvironmentFile') ?? [];
  const [workDir] = u.get('WorkingDirectory') ?? [];
  assert.match(workDir, /^\/.*\/stake-attestation\/server$/);
  const checkout = workDir.replace(/\/stake-attestation\/server$/, '');
  assert.match(envFile, /^\/etc\//);
  assert.equal(envFile.startsWith(`${checkout}/`), false, 'the environment file is outside the checkout');
  assert.match(u.get('ExecStart')[0], /^\/\S*node src\/index\.js$/);
  assert.equal(u.has('Environment'), false, 'every setting is in the environment file, the one place to read them');
});

test('the unit\'s state directory is the template\'s SA_DATA_DIR, and its paths are the template\'s', () => {
  const u = unit();
  const env = parseEnvFile(read(FILES.serverEnv));
  const [state, ...more] = u.get('StateDirectory')[0].split(/\s+/);
  assert.ok(env.get('SA_DATA_DIR').startsWith(`/var/lib/${state}/`), 'SA_DATA_DIR under the unit\'s StateDirectory (the server makes it)');
  // the server makes its build folders inside SA_BUILDER_WORK_DIR, and does not make that one: systemd does
  assert.ok(more.map((d) => `/var/lib/${d}`).includes(env.get('SA_BUILDER_WORK_DIR')), 'SA_BUILDER_WORK_DIR is a StateDirectory of the unit');
  assert.equal(env.get('SA_BUILDER_CONFIG'), `${path.posix.dirname(u.get('EnvironmentFile')[0])}/builder.json`);
});

test('rootless Docker: the user\'s manager is delegated the cpu, memory and pids controllers, so the scan\'s limits apply', () => {
  const text = read(FILES.delegate);
  const m = /^Delegate=(.+)$/m.exec(text);
  assert.ok(m && /^\[Service\]$/m.test(text));
  const controllers = m[1].trim().split(/\s+/);
  for (const c of ['cpu', 'memory', 'pids']) assert.ok(controllers.includes(c), c);
});

// ---------------------------------------------------------------------------------------------- no host details

const kitFiles = () => fs.readdirSync(DEPLOY, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath ?? d.path, d.name));
const runningSection = () => {
  const text = fs.readFileSync(path.join(APP_DIR, 'README.md'), 'utf8');
  const start = text.indexOf('\n## Running the site\n');
  assert.ok(start >= 0, 'README: ## Running the site');
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};
// The names the kit may hold, each one the site's or a public service the code needs. A new one is added here, in review.
const HOSTS = new Set([
  SITE,
  'sepolia.base.org', // Base's public RPC endpoint: the client's reads (client.env, the CSP)
  'gateway.pinata.cloud', 'ipfs.io', // the public gateways the check page reads a disclosed ciphertext from (client.env, the CSP)
  'api.github.com', // the workflow backend and the fork label (SA_GITHUB_API_URL's default)
  'github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org', // SA_CONTROL_GIT_HOSTS's default
  'ghcr.io', // where a listing's image is published (builder.json)
  'docker.io', // where the scan's pinned images come from
  'containerd.io', // not a host: Docker's containerd package, in the README's apt line
  'api.pinata.cloud', // SA_PINATA_API_URL's default
  'nodejs.org', 'letsencrypt.org',
]);
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:org|io|com|net|dev|cloud|app|xyz|link|sh|ai|co|info)\b/gi;

test('no host address, provider account or key in the kit or the README\'s section: only loopback addresses and the names above', () => {
  const texts = [...kitFiles().map((f) => [path.relative(APP_DIR, f), fs.readFileSync(f, 'utf8')]), ['README.md#running-the-site', runningSection()]];
  for (const [name, text] of texts) {
    for (const ip of text.match(IPV4) ?? []) assert.ok(['127.0.0.1', '0.0.0.0'].includes(ip), `${name}: ${ip}`);
    for (const h of text.match(HOSTNAME) ?? []) {
      const host = h.toLowerCase();
      if (/\.(?:js|mjs|json|md|sol|yml|conf|service|sh)$/.test(host)) continue;
      assert.ok(HOSTS.has(host), `${name}: ${host} is not one of the kit's names`);
    }
    assert.doesNotMatch(text, /\b0x[0-9a-fA-F]{64}\b/, `${name}: no 32-byte hex (a key)`);
    assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|-----BEGIN|AKIA[0-9A-Z]{16}/, `${name}: no token`);
    assert.doesNotMatch(text, /https?:\/\/[^\s/"']*@/, `${name}: no credentials in a URL`);
  }
});

// ---------------------------------------------------------------------------------------------- README

test('README "Running the site": the host, the launch order of owner decision Q51, the limits and the upgrade', () => {
  const s = runningSection().replace(/\s+/g, ' ');
  for (const need of ['Node.js 22', 'rootless Docker', 'cgroup v2', 'git', 'nginx', 'certbot', 'SA_DATA_DIR', 'memory.max', 'check-scan-limits.mjs']) {
    assert.ok(s.includes(need), need);
  }
  // the launch order, in order
  const steps = ['deploy_testnet.sh', 'server.env', 'systemctl enable --now verdikta-verifiers', 'required reviewers on', 'turn off required reviewers', 'fixWindowDays', 'npm run smoke'];
  let at = -1;
  for (const step of steps) {
    const i = s.toLowerCase().indexOf(step.toLowerCase(), at + 1);
    assert.ok(i > at, `launch order: "${step}" after the step before it`);
    at = i;
  }
  assert.ok(s.includes('SA_LISTING_FEE_WEI=100000000000000'), 'the listing fee the owner set for the testnet launch');
  assert.match(s, /fixWindowDays.{0,80}\b0\b.{0,40}\b7\b/, 'seeded at fix windows 0 and 7');
  assert.ok(s.includes('.verdikta/stake-control.json'), 'each seeded commit names the maker');
  assert.ok(s.includes('@verdikta/common'), 'a rollback across a common change');
  for (const [zone, { rate }] of zones()) {
    assert.ok(s.includes(zone), `the README names zone ${zone}`);
    assert.ok(s.includes(rate), `the README states ${zone}'s rate, ${rate}`);
  }
});

// What a fresh Ubuntu 24.04 host needed beyond the first version of these steps (node P24).
// The shell blocks of a text: each command line with its continuations joined, comments dropped.
const shellLines = (block) => block.replace(/\\\n\s*/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const shellBlocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
// every command, a chain's split at its &&
const commandLines = (text) => shellBlocks(text).flatMap(shellLines).flatMap((l) => l.split(/\s+&&\s+/)).map((l) => l.trim());

test('README "Running the site": root\'s containerd is stopped with root\'s Docker, and the README says why', () => {
  const s = runningSection();
  const disable = commandLines(s).filter((l) => l.startsWith('sudo systemctl disable --now'));
  assert.equal(disable.length, 1, 'one line stops root\'s daemons');
  const units = disable[0].replace(/#.*$/, '').trim().split(/\s+/).slice(4);
  assert.deepEqual(units.sort(), ['containerd.service', 'docker.service', 'docker.socket']);
  assert.match(s.replace(/\s+/g, ' '), /containerd\.service.{0,400}rootless daemon.{0,40}containerd of its own/i, 'why: the rootless daemon runs its own');
});

test('README "Running the site": Docker\'s packages by name, and the AppArmor profile Ubuntu 24.04 needs', () => {
  const s = runningSection();
  const install = commandLines(s).filter((l) => /^sudo apt-get install\b/.test(l) && l.includes('docker-ce'));
  assert.equal(install.length, 1, 'one install line for Docker');
  const pkgs = install[0].replace(/#.*$/, '').trim().split(/\s+/).slice(3).filter((w) => !w.startsWith('-'));
  assert.deepEqual(pkgs.sort(), ['containerd.io', 'dbus-user-session', 'docker-ce', 'docker-ce-cli', 'docker-ce-rootless-extras', 'uidmap']);
  assert.match(s.replace(/\s+/g, ' '), /docker-ce-rootless-extras[^.]*AppArmor profile[^.]*rootlesskit/, 'the rootless extras bring rootlesskit\'s AppArmor profile');
});

test('README "Running the site": Node.js from the release tarball, its signature checked before its sum and both before it is unpacked', () => {
  const s = runningSection();
  const lines = commandLines(s);
  const at = (re, what) => {
    const i = lines.findIndex((l) => re.test(l));
    assert.ok(i >= 0, what);
    return i;
  };
  const keyring = at(/github\.com\/nodejs\/release-keys\/raw\/HEAD\/gpg\/pubring\.kbx/, 'the keyring of nodejs/release-keys');
  const sig = at(/^gpgv --keyring=\S+ --output SHASUMS256\.txt < SHASUMS256\.txt\.asc\b/, 'gpgv writes the signed SHASUMS256.txt');
  const sum = at(/SHASUMS256\.txt \| sha256sum --check -/, 'the tarball\'s sha256 against the signed sums');
  const unpack = at(/^sudo tar -x\S* "?node-\$\{VERSION\}-\$\{DISTRO\}\.tar\.gz"? -C \/usr\/local\/lib\/nodejs\b/, 'unpacked under /usr/local/lib/nodejs');
  const link = at(/^for b in node npm npx; do sudo ln -sf "\/usr\/local\/lib\/nodejs\/node-\$\{VERSION\}-\$\{DISTRO\}\/bin\/\$b" "\/usr\/bin\/\$b"; done$/, 'node, npm and npx linked into /usr/bin');
  assert.ok(keyring < sig && sig < sum && sum < unpack && unpack < link, 'keyring, signature, sum, unpack, link: in that order');
  // one && chain from the downloads to the links, so a failed check unpacks nothing
  const nodeBlock = shellBlocks(s).find((b) => b.includes('SHASUMS256.txt.asc'));
  const chained = shellLines(nodeBlock).filter((l) => !/^[A-Z_]+=\S+(\s+#.*)?$/.test(l));
  assert.equal(chained.length, 1, `one command, chained with &&, after the variables: ${chained.join(' | ')}`);
  assert.ok(chained[0].indexOf('gpgv') < chained[0].indexOf('sudo tar'), 'the signature first');
  assert.match(s.replace(/\s+/g, ' '), /apt (?:does not|will not|won't) (?:patch|update)/, 'apt does not patch a tarball install');
});
