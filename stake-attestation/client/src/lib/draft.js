// The listing form's model: what the maker types, the checks the form holds itself, and the
// request it sends to POST /api/listings ({ spec, knownIssues?, allowlist }, server
// src/listing/request.js). Every other rule (the schema, the award table, the allowlist's
// addresses, the known issues) is the server's, which checks with @verdikta/common and answers
// with the issues it found; the form does not second-guess it.
//
// The form holds the windows to decision D8 (the contract's bounds): the fix window 0 to 90 days
// (0 allowed), the dispute window 24 to 2160 hours, the reveal window 3 to 90 days (at least
// 72 hours), the disclosure grace no longer than the fix window. Defaults are design §7.1's. Its
// documents field is checked with @verdikta/common's documentGlobProblem (lib/documents.js; node P20).
import { parseEther } from 'ethers';

import { documentIssues, documentLines } from './documents.js';
import { knownIssueEntry } from './knownIssues.js';

export const SEVERITY_CLASSES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const KNOWN_ISSUES_FILE = 'known_issues.json';
const SEVERITY_RUBRIC = 'immunefi-v2.3';

export const WINDOW_DEFAULTS = Object.freeze({
  fixWindowDays: Object.freeze({ repo: 14, contract: 30 }),
  disputeWindowHours: 72,
  disclosureGraceHours: 48,
  revealWindowDays: 7,
});

export const D8 = Object.freeze({
  maxFixDays: 90,
  minDisputeHours: 24,
  maxDisputeHours: 90 * 24,
  minRevealDays: 3,
  maxRevealDays: 90,
});

const WHOLE = /^(0|[1-9][0-9]*)$/;
const ETH = /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/;

export class FormError extends Error {}

/** A fresh form: a repository listing on Foundry with design §7.1's windows. */
export function initialForm() {
  return {
    kind: 'repo',
    repo: '',
    baseCommit: '',
    address: '',
    chainId: '8453',
    scopeInclude: 'src/**',
    scopeExclude: 'test/**\nscript/**',
    documents: '',
    awards: { LOW: '0', MEDIUM: '', HIGH: '', CRITICAL: '' },
    lowestClassCounted: 'MEDIUM',
    bond: '',
    fixWindowDays: String(WINDOW_DEFAULTS.fixWindowDays.repo),
    fixWindowChosen: false,
    disputeWindowHours: String(WINDOW_DEFAULTS.disputeWindowHours),
    disclosureGraceHours: String(WINDOW_DEFAULTS.disclosureGraceHours),
    revealWindowDays: String(WINDOW_DEFAULTS.revealWindowDays),
    allowlist: '',
    knownIssues: [],
    valueAtRiskUsd: '',
    commands: {
      setup: 'forge install',
      build: 'forge build',
      test: 'forge test',
      testFiles: 'forge test --match-path $FILES',
      testIds: 'forge test --match-test $TEST_IDS',
      lint: '',
    },
    testPaths: 'test/**',
    protectedPaths: 'foundry.toml\nlib/**\n.github/**',
    disclosureKey: '',
  };
}

/** The artifact kind; the fix window follows the kind's default until the maker chooses one. */
export function setKind(form, kind) {
  const next = { ...form, kind };
  if (!form.fixWindowChosen) next.fixWindowDays = String(WINDOW_DEFAULTS.fixWindowDays[kind]);
  return next;
}

export function setWindow(form, name, value) {
  return { ...form, [name]: value, ...(name === 'fixWindowDays' ? { fixWindowChosen: true } : {}) };
}

/** "0", or the amount as the spec's "<decimal> ETH" with no trailing zeros. */
export function ethToAmount(text) {
  const wei = BigInt(ethToWei(text));
  if (wei === 0n) return '0';
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} ETH`;
}

/** ETH as typed (up to 18 decimals) in wei, a decimal string. */
export function ethToWei(text) {
  const t = String(text).trim();
  if (!ETH.test(t)) throw new FormError(`not an amount in ETH: ${JSON.stringify(text)}`);
  return parseEther(t).toString();
}

const lines = (text) => String(text).split('\n').map((s) => s.trim()).filter(Boolean);
const whole = (v) => (WHOLE.test(v) ? Number(v) : null);

/**
 * The form's own issues, by field: a key of STRINGS.listing.bounds. Award fields are
 * `awards.<CLASS>`. Empty when the form can be sent.
 */
export function formIssues(form) {
  const out = {};
  const fix = whole(form.fixWindowDays);
  const dispute = whole(form.disputeWindowHours);
  const grace = whole(form.disclosureGraceHours);
  const reveal = whole(form.revealWindowDays);
  if (fix === null) out.fixWindowDays = 'wholeNumber';
  else if (fix > D8.maxFixDays) out.fixWindowDays = 'fixWindow';
  if (dispute === null) out.disputeWindowHours = 'wholeNumber';
  else if (dispute < D8.minDisputeHours || dispute > D8.maxDisputeHours) out.disputeWindowHours = 'disputeWindow';
  if (grace === null) out.disclosureGraceHours = 'wholeNumber';
  else if (fix !== null && grace > fix * 24) out.disclosureGraceHours = 'grace';
  if (reveal === null) out.revealWindowDays = 'wholeNumber';
  else if (reveal < D8.minRevealDays || reveal > D8.maxRevealDays) out.revealWindowDays = 'revealWindow';
  if (form.valueAtRiskUsd.trim() !== '' && whole(form.valueAtRiskUsd.trim()) === null) out.valueAtRiskUsd = 'wholeNumber';
  for (const c of SEVERITY_CLASSES) if (!ETH.test(String(form.awards[c]).trim())) out[`awards.${c}`] = 'amount';
  if (!ETH.test(form.bond.trim())) out.bond = 'amount';
  // each line common would refuse, at its index, by common's code
  const documents = documentIssues(documentLines(form.documents ?? ''));
  if (documents.length) out.documents = documents;
  return out;
}

/** The body of POST /api/listings. Throws FormError while formIssues(form) has anything. */
export function toListingRequest(form) {
  const issues = formIssues(form);
  if (Object.keys(issues).length) throw new FormError(`the form has issues (${Object.entries(issues).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((i) => i.code).join(' ') : v}`).join(', ')})`);

  const commands = { framework: 'forge' };
  for (const [k, v] of Object.entries(form.commands)) if (v.trim()) commands[k] = v.trim();
  const protectedPaths = lines(form.protectedPaths);
  const exclude = lines(form.scopeExclude);
  const documents = documentLines(form.documents ?? '');
  const knownIssues = form.knownIssues.map(knownIssueEntry);
  const value = form.valueAtRiskUsd.trim();

  const spec = {
    version: 1,
    kind: 'bug',
    ...(form.kind === 'contract'
      ? { artifact: { kind: 'contract', address: form.address.trim(), chainId: WHOLE.test(form.chainId.trim()) ? Number(form.chainId.trim()) : form.chainId.trim() } }
      : {}),
    repo: form.repo.trim(),
    baseCommit: form.baseCommit.trim(),
    env: { from: 'foundry' },
    attestation: 'attestation.json',
    commands,
    baseline: 'baseline.json',
    paths: { tests: lines(form.testPaths), ...(protectedPaths.length ? { protected: protectedPaths } : {}) },
    stake: {
      awards: Object.fromEntries(SEVERITY_CLASSES.map((c) => [c, ethToAmount(form.awards[c])])),
      lowestClassCounted: form.lowestClassCounted,
      bondWei: ethToWei(form.bond),
      fixWindowDays: Number(form.fixWindowDays),
      disputeWindowHours: Number(form.disputeWindowHours),
      disclosureGraceHours: Number(form.disclosureGraceHours),
      revealWindowDays: Number(form.revealWindowDays),
      scope: { include: lines(form.scopeInclude), ...(exclude.length ? { exclude } : {}) },
      // where the code's requirements are written; none named, no field, and the request is what it was
      ...(documents.length ? { documents } : {}),
      ...(knownIssues.length ? { knownIssues: KNOWN_ISSUES_FILE } : {}),
      severityRubric: SEVERITY_RUBRIC,
      disclosureKey: form.disclosureKey,
      ...(value ? { valueAtRiskUsd: Number(value) } : {}),
    },
  };
  return { spec, ...(knownIssues.length ? { knownIssues } : {}), allowlist: lines(form.allowlist) };
}

const OUTCOME_OF_CLASS = Object.freeze({ LOW: 2, MEDIUM: 3, HIGH: 4, CRITICAL: 5 }); // StakeAttestation.Outcome
const lower = (v) => String(v).toLowerCase();

/**
 * Where the server's list() arguments differ from the request the maker sent: the client sends
 * list() only when this is empty, so the listing goes on-chain with the maker's own disclosure
 * key and terms whatever the server answered. The oracle settings are the site's, not the
 * maker's, and are not compared.
 * @param {{ spec: object, knownIssues?: object[], allowlist: string[] }} sent - toListingRequest's body
 * @param {{ params: object, knownIssueIds: string[] }} list - the ready view's `list`
 * @param {(recipient: string) => string} keyBytes32 - the disclosure key as list() stores it
 * @returns {string[]} the names of the arguments that differ
 */
export function listMismatches(sent, list, keyBytes32) {
  const { spec } = sent;
  const p = list.params;
  const out = [];
  const contract = spec.artifact?.kind === 'contract';
  const a = p.artifact ?? {};
  if (Number(a.kind) !== (contract ? 1 : 0) || a.repo !== spec.repo || a.baseCommit !== spec.baseCommit
    || String(a.chainId) !== (contract ? String(spec.artifact.chainId) : '0')
    || lower(a.addr) !== (contract ? lower(spec.artifact.address) : '0x0000000000000000000000000000000000000000')) out.push('artifact');
  let key = null;
  try {
    key = keyBytes32(spec.stake.disclosureKey);
  } catch {
    // unreadable: it cannot match
  }
  if (key === null || lower(p.disclosureKey) !== lower(key)) out.push('disclosureKey');
  const awards = SEVERITY_CLASSES.map((c) => (spec.stake.awards[c] === '0' ? '0' : ethToWei(spec.stake.awards[c].replace(/ ETH$/, ''))));
  if (!Array.isArray(p.awards) || p.awards.map(String).join() !== awards.join()) out.push('awards');
  if (Number(p.lowestClassCounted) !== OUTCOME_OF_CLASS[spec.stake.lowestClassCounted]) out.push('lowestClassCounted');
  if (String(p.bondWei) !== spec.stake.bondWei) out.push('bondWei');
  if (Number(p.fixWindow) !== spec.stake.fixWindowDays * 86400) out.push('fixWindow');
  if (Number(p.disputeWindow) !== spec.stake.disputeWindowHours * 3600) out.push('disputeWindow');
  if (Number(p.disclosureGrace) !== spec.stake.disclosureGraceHours * 3600) out.push('disclosureGrace');
  if (Number(p.revealWindow) !== spec.stake.revealWindowDays * 86400) out.push('revealWindow');
  if (!Array.isArray(p.allowlist) || p.allowlist.map(lower).join() !== sent.allowlist.map(lower).join()) out.push('allowlist');
  if (String(p.valueAtRiskUsd) !== String(spec.stake.valueAtRiskUsd ?? 0)) out.push('valueAtRiskUsd');
  const ids = (sent.knownIssues ?? []).map((k) => `0x${k.id.slice('sha256:'.length)}`).sort();
  if (!Array.isArray(list.knownIssueIds) || [...list.knownIssueIds].map(lower).sort().join() !== ids.join()) out.push('knownIssueIds');
  return out;
}
