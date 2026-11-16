// The deploy kit's readers (node P23): the header include nginx loads, read as nginx reads it, the
// Content-Security-Policy in it, the one substitution the client's CSP test makes, and env files.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapConnectSources, parseCsp, parseEnvFile, parseHeaderInclude, parseNginx, serializeCsp } from '../src/deployKit.js';

test('parseHeaderInclude reads add_header lines, with or without always, and skips comments and blank lines', () => {
  const text = [
    '# a comment',
    '',
    '  add_header X-Content-Type-Options "nosniff" always;',
    'add_header Referrer-Policy "no-referrer";   # trailing comment',
  ].join('\n');
  assert.deepEqual(parseHeaderInclude(text), [
    { name: 'X-Content-Type-Options', value: 'nosniff', always: true },
    { name: 'Referrer-Policy', value: 'no-referrer', always: false },
  ]);
});

test('parseHeaderInclude refuses anything it cannot read exactly, so a test never applies less than nginx would', () => {
  for (const line of [
    'add_header X-A nosniff always;', // unquoted value
    'add_header X-A "a" always', // no semicolon
    'add_header X-A "$host" always;', // an nginx variable: interpolated at run time
    'add_header X-A "a\\"b" always;', // an escape
    'add_header X-A "a" sometimes;',
    'more_set_headers "X-A: a";',
    'include other.conf;',
    'add_header X-A "a" always; add_header X-B "b" always;',
  ]) {
    assert.throws(() => parseHeaderInclude(line), /line 1/, line);
  }
  assert.throws(() => parseHeaderInclude('add_header X-A "a" always;\nadd_header x-a "b" always;'), /twice/);
});

test('parseCsp keeps the directives in order with their sources; serializeCsp writes them back', () => {
  const policy = "default-src 'none'; script-src 'self'; connect-src 'self' https://rpc.example https://gw.example";
  const parsed = parseCsp(policy);
  assert.deepEqual(parsed, [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'"]],
    ['connect-src', ["'self'", 'https://rpc.example', 'https://gw.example']],
  ]);
  assert.equal(serializeCsp(parsed), policy);
  assert.throws(() => parseCsp("script-src 'self'; SCRIPT-SRC 'none'"), /twice/);
  assert.deepEqual(parseCsp("  base-uri   'none' ;; "), [['base-uri', ["'none'"]]]);
});

test('mapConnectSources swaps exactly the named origins in connect-src and nothing else', () => {
  const policy = "default-src 'none'; img-src 'self' https://rpc.example; connect-src 'self' https://rpc.example https://gw.example";
  const mapped = mapConnectSources(policy, { 'https://rpc.example': 'http://127.0.0.1:8545', 'https://gw.example': 'http://127.0.0.1:9000' });
  assert.equal(mapped, "default-src 'none'; img-src 'self' https://rpc.example; connect-src 'self' http://127.0.0.1:8545 http://127.0.0.1:9000");
});

test('mapConnectSources refuses a connect-src that holds anything but self and the named origins, or lacks one', () => {
  const map = { 'https://rpc.example': 'http://127.0.0.1:1', 'https://gw.example': 'http://127.0.0.1:2' };
  assert.throws(() => mapConnectSources("connect-src 'self' https://rpc.example https://gw.example https://other.example", map), /other\.example/);
  assert.throws(() => mapConnectSources("connect-src 'self' https://rpc.example", map), /gw\.example/);
  assert.throws(() => mapConnectSources("connect-src https://rpc.example https://gw.example", map), /'self'/);
  assert.throws(() => mapConnectSources("default-src 'self'", map), /connect-src/);
});

test('parseEnvFile reads NAME=value lines, keeps an empty value, and skips comments', () => {
  const env = parseEnvFile('# c\nA=1\n\nB=\n  C=x y\n# D=commented\n');
  assert.deepEqual([...env], [['A', '1'], ['B', ''], ['C', 'x y']]);
  assert.throws(() => parseEnvFile('A=1\nA=2\n'), /twice/);
  assert.throws(() => parseEnvFile('not a line\n'), /line 1/);
  assert.throws(() => parseEnvFile('A="quoted"\n'), /quote/);
  // systemd's EnvironmentFile has no trailing comments: the text would become part of the value
  assert.throws(() => parseEnvFile('A=1 # the default\n'), /comment/);
});

test('parseNginx reads directives and blocks, with comments and quoted strings', () => {
  const tree = parseNginx([
    '# top',
    'limit_req_zone $binary_remote_addr zone=a:10m rate=5r/s;',
    'server {',
    '  listen 443 ssl; # trailing',
    '  location = /api/listings {',
    '    limit_req zone=a burst=3 nodelay;',
    '  }',
    '  return 301 "https://x.example$request_uri";',
    '}',
  ].join('\n'));
  assert.deepEqual(tree, [
    { name: 'limit_req_zone', args: ['$binary_remote_addr', 'zone=a:10m', 'rate=5r/s'] },
    {
      name: 'server',
      args: [],
      block: [
        { name: 'listen', args: ['443', 'ssl'] },
        { name: 'location', args: ['=', '/api/listings'], block: [{ name: 'limit_req', args: ['zone=a', 'burst=3', 'nodelay'] }] },
        { name: 'return', args: ['301', 'https://x.example$request_uri'] },
      ],
    },
  ]);
  assert.throws(() => parseNginx('server { listen 80;'), /unclosed/);
  assert.throws(() => parseNginx('listen 80'), /;/);
  assert.throws(() => parseNginx('}'), /unexpected/);
});
