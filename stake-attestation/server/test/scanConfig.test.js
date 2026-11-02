// The scan's and the sign-in's settings (node P4b2), from the environment like the rest of the
// config: the variables the scan step is given, whether it runs the agent pass, and how long a
// sign-in challenge lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, loadConfig } from '../src/config.js';

test('defaults: no variables for the scan beyond PATH and HOME, no agent pass, five-minute challenges', () => {
  const c = loadConfig({});
  assert.deepEqual(c.builder.scanEnv, []);
  assert.equal(c.builder.scanAgent, false);
  assert.equal(c.auth.challengeTtlMs, 300000);
});

test('SA_BUILDER_SCAN_ENV names the scan step\'s variables; never one of the server\'s own', () => {
  assert.deepEqual(loadConfig({ SA_BUILDER_SCAN_ENV: 'DOCKER_HOST, OPENROUTER_API_KEY' }).builder.scanEnv, ['DOCKER_HOST', 'OPENROUTER_API_KEY']);
  assert.throws(() => loadConfig({ SA_BUILDER_SCAN_ENV: 'SA_PINATA_JWT' }), ConfigError);
  assert.throws(() => loadConfig({ SA_BUILDER_SCAN_ENV: 'not a name' }), ConfigError);
});

test('SA_SCAN_AGENT is on or off', () => {
  assert.equal(loadConfig({ SA_SCAN_AGENT: 'on' }).builder.scanAgent, true);
  assert.equal(loadConfig({ SA_SCAN_AGENT: 'off' }).builder.scanAgent, false);
  assert.throws(() => loadConfig({ SA_SCAN_AGENT: 'yes' }), ConfigError);
});

test('SA_AUTH_CHALLENGE_TTL_MS is whole seconds from 10 s to an hour', () => {
  assert.equal(loadConfig({ SA_AUTH_CHALLENGE_TTL_MS: '60000' }).auth.challengeTtlMs, 60000);
  for (const bad of ['5000', '3600001', '60500', 'soon']) assert.throws(() => loadConfig({ SA_AUTH_CHALLENGE_TTL_MS: bad }), ConfigError, bad);
});
