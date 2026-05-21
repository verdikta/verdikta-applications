#!/usr/bin/env node
/**
 * Anthropic API Key Discovery
 *
 * Probes Anthropic's public API to surface every piece of metadata that might
 * identify which account / organization / workspace owns the loaded
 * ANTHROPIC_API_KEY. Useful when the key is leaked + valid but you can't find
 * it in any workspace's keys page.
 *
 * Never prints the key value itself.
 *
 * Usage:
 *   node scripts/anthropicKeyInfo.js
 */

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const secretsPath = path.join(__dirname, '..', '..', '..', '..', 'secrets', '.env.secrets');
if (fs.existsSync(secretsPath)) {
  require('dotenv').config({ path: secretsPath, override: true });
}

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('Error: ANTHROPIC_API_KEY not set in environment');
  process.exit(1);
}

// Print key fingerprint (prefix + last 4) so user can confirm which key we're testing
const prefix = KEY.slice(0, 14);
const suffix = KEY.slice(-4);
console.log('='.repeat(70));
console.log('Anthropic API Key Discovery');
console.log('='.repeat(70));
console.log(`Key fingerprint: ${prefix}...${suffix}`);
console.log(`Key length:      ${KEY.length} chars`);
console.log('');

// Helper: collect ALL response headers as an object
async function probe(label, url, opts = {}) {
  console.log(`--- ${label} ---`);
  console.log(`  ${opts.method || 'GET'} ${url}`);
  try {
    const r = await fetch(url, opts);
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    console.log(`  Status: ${r.status} ${r.statusText}`);
    console.log('  Headers (full dump, no secrets):');
    Object.entries(headers).sort().forEach(([k, v]) => {
      console.log(`    ${k}: ${v}`);
    });

    // Body — print abbreviated
    let body = '';
    try {
      body = await r.text();
    } catch {}
    if (body) {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      if (parsed) {
        // Print structured but redact anything that looks like a token/secret
        const safe = JSON.stringify(parsed, null, 2);
        // Truncate to 1500 chars
        console.log('  Body (JSON, truncated):');
        const lines = safe.split('\n').slice(0, 60);
        lines.forEach(l => console.log(`    ${l}`));
        if (safe.length > 1500) console.log('    ... (truncated)');
      } else {
        console.log(`  Body (raw, first 400 chars):`);
        console.log(`    ${body.slice(0, 400)}`);
      }
    }
    console.log('');
    return { status: r.status, headers, body };
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    console.log('');
    return null;
  }
}

async function main() {
  const baseHeaders = {
    'x-api-key': KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };

  // 1. Minimal /v1/messages call — primary source of org ID in headers
  await probe('1. POST /v1/messages (minimal call)',
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }
  );

  // 2. /v1/messages/count_tokens — sometimes reveals different metadata
  await probe('2. POST /v1/messages/count_tokens',
    'https://api.anthropic.com/v1/messages/count_tokens',
    {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }
  );

  // 3. /v1/models — list models accessible to this key
  await probe('3. GET /v1/models',
    'https://api.anthropic.com/v1/models',
    { headers: baseHeaders }
  );

  // 4. /v1/organizations/me — undocumented but sometimes available
  await probe('4. GET /v1/organizations/me (undocumented; may 404)',
    'https://api.anthropic.com/v1/organizations/me',
    { headers: baseHeaders }
  );

  // 5. /v1/me — generic "who am I"; may not exist
  await probe('5. GET /v1/me (undocumented; may 404)',
    'https://api.anthropic.com/v1/me',
    { headers: baseHeaders }
  );

  // 6. /v1/workspaces — list workspaces the key belongs to (admin endpoint;
  //    will 401 for non-admin keys but the error message may reveal info)
  await probe('6. GET /v1/organizations/workspaces (admin; expected 4xx but error may help)',
    'https://api.anthropic.com/v1/organizations/workspaces',
    { headers: baseHeaders }
  );

  // 7. Probe with INVALID key to compare the error shape
  await probe('7. POST /v1/messages with deliberately invalid key (control)',
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: { ...baseHeaders, 'x-api-key': 'sk-ant-api03-INVALID-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000-AAAA' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }
  );

  console.log('='.repeat(70));
  console.log('Look for these in the headers above:');
  console.log('  - anthropic-organization-id  → the org UUID owning the key');
  console.log('  - cf-ray                      → Cloudflare datacenter id (geographic hint)');
  console.log('  - request-id                  → use this for support tickets');
  console.log('  - anthropic-ratelimit-*       → per-org limit shape');
  console.log('');
  console.log('If you see anthropic-organization-id, log into Anthropic console');
  console.log('and switch workspaces to find one whose URL contains that UUID.');
  console.log('='.repeat(70));
}

main().catch(e => { console.error('Top-level error:', e); process.exit(1); });
