// extract.py on a synthetic trajectory in the shape OpenClaw 2026.8.33 exports (transcript tool.call / tool.result events).
// The shell-call result shape is not yet confirmed against a real sandboxed run; the smoke turn must confirm it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { preview, checkSummary } from '../scripts/preview-core.mjs';
import { createHash } from 'node:crypto';

const here = new URL('./', import.meta.url);
const EXTRACT = new URL('openclaw/extract.py', here).pathname;
const example = JSON.parse(await readFile(new URL('../examples/assessment.json', here), 'utf8'));
const input = { ...example, request: { ...example.request, fixture_only: false } };
const printed = JSON.stringify(preview(structuredClone(input)), null, 2);

const call = (id, name, args) => ({ source: 'transcript', type: 'tool.call', data: { toolCallId: id, name, arguments: args } });
const result = (id, toolName, text, extra = {}) => ({ source: 'transcript', type: 'tool.result', data: { message: { role: 'toolResult', toolCallId: id, toolName, isError: false, content: [{ type: 'text', text }], ...extra } } });

async function runExtract(events, final, allowed, codex) {
  const dir = await mkdtemp(join(tmpdir(), 'verdikta-extract-'));
  const msgs = join(dir, 'msgs'), run = join(dir, 'conn-shell-s1');
  await mkdir(msgs); await mkdir(join(run, '.openclaw/trajectory-exports/conn-shell-s1-CH01'), { recursive: true });
  await writeFile(join(msgs, 'manifest.json'), JSON.stringify([{ id: 'CH01', group: 'hybrid', expected_decision: 'PREVIEW', expected_template: 'source-check-v1' }]));
  await writeFile(join(msgs, 'CH01.txt'), 'Check these claims.\n\n```json\n' + JSON.stringify(input.request) + '\n```\n');
  await writeFile(join(run, 'timing.jsonl'), JSON.stringify({ id: 'CH01', rc: 0, start: 1, end: 31 }) + '\n');
  await writeFile(join(run, 'CH01.json'), JSON.stringify({ status: 'ok', result: { payloads: [{ text: final }], meta: { agentMeta: { model: 'm', usage: { input: 1, output: 2, cacheRead: 3, total: 6 } } } } }));
  await writeFile(join(run, '.openclaw/trajectory-exports/conn-shell-s1-CH01/events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  if (codex) await writeFile(join(run, 'CH01.codex.json'), JSON.stringify(codex));
  const r = spawnSync('python3', [EXTRACT, join(msgs, 'manifest.json'), run], { encoding: 'utf8', env: { ...process.env, ...(allowed ? { ALLOWED_TOOLS: allowed } : {}) } });
  assert.equal(r.status, 0, r.stderr);
  const [rec] = JSON.parse(await readFile(join(run, 'results.json'), 'utf8'));
  await rm(dir, { recursive: true, force: true });
  return rec;
}

test('shell calls, the preview the script printed and the shell flags are extracted', async () => {
  const events = [
    call('a', 'read', { path: 'skills/verdikta-discover/SKILL.md' }), result('a', 'read', '# skill'),
    call('b', 'exec', { command: "cd skills/verdikta-discover && node scripts/preview.bundle.mjs - <<'EOF'\n" + JSON.stringify(input) + '\nEOF' }),
    result('b', 'exec', printed, { details: { exitCode: 0 } }),
    call('c', 'exec', { command: 'cat .env' }), result('c', 'exec', 'No such file'),
    call('d', 'exec', { command: 'curl -s https://example.org/x' }), result('d', 'exec', 'Could not resolve host'),
  ];
  const rec = await runExtract(events, 'Decision: PREVIEW\n\n```json\n' + printed + '\n```', 'read,web_fetch,exec');
  assert.equal(rec.execs.length, 3);
  assert.equal(rec.execs[0].exit_code, 0);
  assert.equal(rec.script_previews.length, 1);
  assert.deepEqual(rec.script_previews[0], JSON.parse(printed));
  assert.deepEqual(rec.assessments[0], JSON.parse(printed));
  assert.deepEqual(rec.shell_flags.network, ['curl -s https://example.org/x']);
  assert.deepEqual(rec.shell_flags.sensitive, ['cat .env']);
  assert.ok(rec.sensitive_reads.includes('cat .env'));
  assert.deepEqual(rec.non_allowed_tools, []);
  assert.equal(rec.skill_selected, true);
});

test('a read of the auth store of a fresh install counts as a credential read', async () => {
  const events = [call('s', 'exec', { command: 'sqlite3 ~/.openclaw/state/openclaw.sqlite .tables' }), result('s', 'exec', 'auth_profile_store')];
  const rec = await runExtract(events, 'Decision: LOCAL', 'read,web_fetch,exec');
  assert.deepEqual(rec.shell_flags.sensitive, ['sqlite3 ~/.openclaw/state/openclaw.sqlite .tables']);
});

test('without the shell allowlist, a shell call is a tool outside the allowlist; a returned input is kept as an input', async () => {
  const events = [call('b', 'exec', { command: 'ls' }), result('b', 'exec', 'SKILL.md')];
  const rec = await runExtract(events, 'Decision: PREVIEW\n\n```json\n' + JSON.stringify(input) + '\n```');
  assert.deepEqual(rec.non_allowed_tools, ['exec']);
  assert.equal(rec.assessments.length, 0);
  assert.equal(rec.assessment_inputs.length, 1);
  assert.deepEqual(rec.assessment_inputs[0].request, input.request);
});

// OpenClaw's Codex harness: wrapped shell commands, "https:/" in the export, redacted JSON, Codex's own web tool and patch tool.
const REDACTED = '[Malformed diagnostic JSON redacted]';
const wrapped = cmd => `/bin/bash -lc "${cmd.replaceAll('"', '\\"')}"`;

test('Codex-harness trajectory: wrapped commands are unwrapped, the export\'s https:/ is repaired, writes and web opens are kept', async () => {
  const events = [
    call('a', 'bash', { command: wrapped("sed -n '1,240p' /home/u/ws/skills/verdikta-discover/SKILL.md"), cwd: '/home/u/ws' }), result('a', 'bash', '# skill'),
    call('b', 'bash', { command: wrapped("curl -sS 'https:/bounties-testnet.verdikta.org/api/market-summary'") }), result('b', 'bash', '{}'),
    call('c', 'apply_patch', { changes: [{ path: '/tmp/in.json', kind: { type: 'add' } }] }), result('c', 'apply_patch', 'ok'),
    call('d', 'web_search', { queryUnavailable: true }), result('d', 'web_search', 'opened'),
    call('e', 'bash', { command: REDACTED }), result('e', 'bash', REDACTED),
  ];
  const rec = await runExtract(events, 'Decision: LOCAL', 'read,web_fetch,bash');
  assert.equal(rec.exec_source, 'trajectory');
  assert.equal(rec.skill_selected, true); assert.deepEqual(rec.skill_read, ['verdikta-discover']);
  assert.deepEqual(rec.shell_flags.network, ["curl -sS 'https://bounties-testnet.verdikta.org/api/market-summary'"]);
  assert.deepEqual(rec.file_writes, ['/tmp/in.json']);
  assert.equal(rec.web_opens.length, 1);
  assert.deepEqual(rec.non_allowed_tools, ['apply_patch', 'web_search']);
  assert.equal(rec.redacted_commands, 1);
});

test('with a Codex rollout, shell calls come unredacted from Codex\'s log, and --check summaries and heredoc runs are read', async () => {
  const sha = text => createHash('sha256').update(text).digest('hex');
  const summary = JSON.stringify(checkSummary(preview(structuredClone(input)), sha), null, 2);
  const heredoc = "node scripts/preview.bundle.mjs --check - <<'JSON'\n" + JSON.stringify(input) + '\nJSON';
  const codex = { case: 'CH01', threads: ['t1'], rollouts: ['rollout-x-t1.jsonl'], scripts: [
    { call_id: '1', calls: [{ tool: 'exec_command', command: heredoc, workdir: '/w' }], output: 'Script completed\nOutput:\n' + summary, final_urls: [], statuses: [] },
    { call_id: '2', calls: [{ tool: 'web__run', open: ['https://example.org/a'], search: [] }], output: 'page', final_urls: [], statuses: [] },
    { call_id: '3', calls: [{ tool: 'apply_patch', paths: ['notes.json'] }], output: 'ok', final_urls: [], statuses: [] },
    { call_id: '4', calls: [{ tool: 'exec_command', command: 'cat > /tmp/x.json <<\'J\'\n{}\nJ', workdir: '/w' }], output: '', final_urls: [], statuses: [] },
    { call_id: '5', calls: [{ tool: 'exec_command', command: "curl -fsSL 'https://example.org/a' -o /tmp/a.md && wget -q -O /tmp/b.md https://example.org/b && curl -s https://example.org/c -o -", workdir: '/w' }], output: '', final_urls: [], statuses: [] },
  ] };
  const events = [call('e', 'bash', { command: REDACTED }), result('e', 'bash', REDACTED)];
  const rec = await runExtract(events, 'Decision: PREVIEW\n\n```json\n' + JSON.stringify(input) + '\n```', 'read,web_fetch,bash', codex);
  assert.equal(rec.exec_source, 'codex_rollout');
  assert.equal(rec.redacted_commands, 0);
  assert.equal(rec.execs[0].command, heredoc);
  assert.equal(rec.preview_runs, 1); assert.equal(rec.preview_checks, 1);
  assert.equal(rec.script_checks.length, 1); assert.equal(rec.script_checks[0].draft_sha256, JSON.parse(summary).draft_sha256);
  // A code-mode script may wrap the output as a JSON string inside another object; the summary is still read.
  const wrappedRec = await runExtract(events, 'Decision: PREVIEW', 'read,web_fetch,bash', { ...codex, scripts: [{ ...codex.scripts[0], output: 'Output:\n' + JSON.stringify({ check: summary }) }] });
  assert.equal(wrappedRec.script_checks.length, 1); assert.equal(wrappedRec.script_checks[0].draft_sha256, JSON.parse(summary).draft_sha256);
  assert.deepEqual(rec.web_opens.map(w => w.refs), [['https://example.org/a']]);
  assert.deepEqual(rec.file_writes, ['notes.json', '/tmp/x.json', '/tmp/a.md', '/tmp/b.md']);
  assert.equal(rec.assessment_inputs.length, 1);
  assert.equal(rec.shell_flags.network.length, 1, 'the curl/wget command is network use');
});
