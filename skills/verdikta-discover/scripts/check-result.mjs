#!/usr/bin/env node
// Hunter-side check of a work-order result before it is submitted. Reads only the files named on the command line; no
// network, no environment, nothing written. Validates result.json against the template's result schema and the request the
// bounty committed to, with the same code the evaluator's rubric assumes (scripts/validation.mjs).
//
//   node scripts/check-result.bundle.mjs --description bounty-description.txt --result result.json
//   node scripts/check-result.bundle.mjs --request request.json --result result.json [--template <id>] [--allow-fixture]
//
// --description takes the bounty's evaluation description (GET /api/jobs/:id -> description, or the text on the bounty page):
// the template, the exact request bytes and the digest result.input_sha256 must carry are read from it. --request takes the
// request as a file whose bytes are exactly the committed ones (the digest is computed from the file). Prints one JSON object:
// { ok, template_id, task_id, input_sha256, errors } and exits 1 when the result would fail.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateResult } from './validation.mjs';
import { parseWorkOrderDescription } from './work-order.mjs';
import { inferTemplateId } from './preview-core.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = name => args.includes(name);
const read = async name => (name === '-' ? await new Promise(resolve => { let t = ''; process.stdin.on('data', c => { t += c; }); process.stdin.on('end', () => resolve(t)); }) : readFile(name, 'utf8'));
const out = (obj, code) => { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); process.exitCode = code; };

try {
  const resultPath = flag('--result');
  if (!resultPath || (!flag('--description') && !flag('--request'))) throw new Error('Usage: check-result.mjs (--description FILE | --request FILE [--template ID]) --result FILE [--allow-fixture]');
  const result = JSON.parse(await read(resultPath));
  let templateId, request, digest, parseErrors = [];
  if (flag('--description')) {
    const parsed = parseWorkOrderDescription(await read(flag('--description')));
    if (!parsed) throw new Error('The description carries no work order (no Service line, digest line and request line)');
    ({ templateId, request, requestDigest: digest } = parsed); parseErrors = parsed.errors;
  } else {
    const text = await read(flag('--request'));
    request = JSON.parse(text); digest = createHash('sha256').update(text).digest('hex');
    templateId = flag('--template') ?? inferTemplateId(request);
    if (!templateId) throw new Error('Name the template with --template; the request shape does not identify one');
  }
  const errors = parseErrors.length ? parseErrors : validateResult(templateId, request, result, digest, { production: !has('--allow-fixture') });
  out({ ok: errors.length === 0, template_id: templateId, task_id: request?.task_id ?? null, input_sha256: digest, errors }, errors.length ? 1 : 0);
} catch (error) {
  out({ ok: false, errors: [error.message] }, 1);
}
