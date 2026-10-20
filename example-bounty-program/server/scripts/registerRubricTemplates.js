#!/usr/bin/env node
/**
 * Add rubric templates to utils/rubricTemplateFingerprints.json, the list the server
 * uses to tell which template a bounty was built from (utils/templateUsage.js). Run it
 * after adding or changing a template. Versions already listed are kept, so bounties
 * built from an older version still count toward their template.
 *
 * Two kinds are listed:
 *   rubric   the create page's templates (shared/rubricTemplates.json). A new version
 *            takes its name from a "(name-vN)" tag in the title, as Mutual Wager has;
 *            otherwise it is <key>-v<N>, numbered after the versions already listed.
 *   service  the verdikta-discover work-order templates (skills/verdikta-discover/
 *            templates/*.template.json and their rubric files), named
 *            <template_id>@<template_version>.
 *
 * Usage (from example-bounty-program/server):
 *   node scripts/registerRubricTemplates.js            # add new versions, write the file
 *   node scripts/registerRubricTemplates.js --check    # exit 1 if a template is not listed
 *   node scripts/registerRubricTemplates.js --from old/rubricTemplates.mjs --note "git 4663498"
 *                                                      # list the versions in an older copy
 *   node scripts/registerRubricTemplates.js --services-from old/templates --note "git 97a49aa"
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { rubricFingerprint } = require('../utils/templateUsage');

const REGISTRY_FILE = path.join(__dirname, '..', 'utils', 'rubricTemplateFingerprints.json');
const SHARED_TEMPLATES = path.join(__dirname, '..', '..', 'shared', 'rubricTemplates.json');
const SERVICE_TEMPLATES = path.join(__dirname, '..', '..', '..', 'skills', 'verdikta-discover', 'templates');

// "source-check-v1" -> "Source Check"
const serviceLabel = (id) => id.replace(/-v\d+$/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** [{ key, kind, label, title, version?, criteria, forbiddenContent }] from shared/rubricTemplates.json's shape. */
function rubricEntries(templates) {
  return Object.entries(templates).map(([key, t]) => ({
    key, kind: 'rubric', label: t.label || t.title, title: t.title,
    criteria: t.criteria, forbiddenContent: t.forbiddenContent || t.forbidden_content,
  }));
}

/** The same for a directory of verdikta-discover *.template.json files. */
function serviceEntries(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.template.json')).sort().map((f) => {
    const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const rubric = JSON.parse(fs.readFileSync(path.join(dir, t.rubric_file), 'utf8'));
    return {
      key: t.template_id, kind: 'service', label: serviceLabel(t.template_id), title: rubric.title,
      version: `${t.template_id}@${t.template_version}`,
      criteria: rubric.criteria, forbiddenContent: rubric.forbiddenContent || rubric.forbidden_content,
    };
  });
}

/**
 * The registry with every entry listed. Returns { registry, added: [{ key, version,
 * fingerprint }] }; the input is not changed.
 */
function registerTemplates(current, entries, { note = null } = {}) {
  const registry = JSON.parse(JSON.stringify(current));
  const added = [];
  for (const e of entries) {
    const fingerprint = rubricFingerprint(e.criteria, e.forbiddenContent);
    const known = Object.values(registry.templates).some((t) => t.versions.some((v) => v.fingerprint === fingerprint));
    const entry = registry.templates[e.key] ||= { kind: e.kind, label: e.label, criteriaIds: [], versions: [] };
    entry.kind = e.kind;
    entry.label = e.label;
    if (known) continue;
    const tag = /\(([a-z0-9-]+-v\d+)\)\s*$/i.exec(e.title || '')?.[1];
    const version = e.version || tag || `${e.key}-v${entry.versions.length + 1}`;
    // The newest version's ids decide which rubrics count as a modified copy.
    entry.criteriaIds = e.criteria.map((c) => c.id);
    entry.versions.push({ version, fingerprint, ...(note && { note }) });
    added.push({ key: e.key, version, fingerprint });
  }
  return { registry, added };
}

async function main() {
  const argv = process.argv.slice(2);
  const getOpt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  let entries;
  if (getOpt('from')) {
    const mod = await import(pathToFileURL(path.resolve(getOpt('from'))).href);
    // Older copies are JS modules whose labels come from getTemplateOptions().
    const labels = Object.fromEntries((mod.getTemplateOptions?.() || [])
      .map((o) => [o.value, o.label.replace(/^[^\p{L}\p{N}]+/u, '').trim()]));
    entries = rubricEntries(Object.fromEntries(Object.entries(mod.rubricTemplates)
      .map(([key, t]) => [key, { ...t, label: labels[key] }])));
  } else if (getOpt('services-from')) {
    entries = serviceEntries(path.resolve(getOpt('services-from')));
  } else {
    entries = [
      ...rubricEntries(JSON.parse(fs.readFileSync(SHARED_TEMPLATES, 'utf8')).templates),
      ...serviceEntries(SERVICE_TEMPLATES),
    ];
  }
  const current = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  const { registry, added } = registerTemplates(current, entries, { note: getOpt('note') });

  for (const a of added) console.log(`${a.key}: ${a.version} (${a.fingerprint})`);
  if (argv.includes('--check')) {
    if (added.length) {
      console.error(`${added.length} template version(s) not listed. Run: node scripts/registerRubricTemplates.js`);
      process.exit(1);
    }
    console.log('Every template version is listed.');
    return;
  }
  if (!added.length && JSON.stringify(registry) === JSON.stringify(current)) {
    console.log('Every template version is already listed.');
    return;
  }
  fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`Listed ${added.length} version(s) in ${path.relative(process.cwd(), REGISTRY_FILE)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { registerTemplates, rubricEntries, serviceEntries };
