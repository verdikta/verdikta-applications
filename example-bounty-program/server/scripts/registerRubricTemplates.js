#!/usr/bin/env node
/**
 * Add the create page's rubric templates to utils/rubricTemplateFingerprints.json,
 * the list the server uses to tell which template a bounty was built from
 * (utils/templateUsage.js). Run it after adding or changing a template. Versions
 * already listed are kept, so bounties built from an older version still count
 * toward their template.
 *
 * A new version takes its name from a "(name-vN)" tag in the template title, as the
 * Mutual Wager template has; otherwise it is <key>-v<N>, numbered after the versions
 * already listed for that key.
 *
 * Usage (from example-bounty-program/server):
 *   node scripts/registerRubricTemplates.js            # add new versions, write the file
 *   node scripts/registerRubricTemplates.js --check    # exit 1 if a template is not listed
 *   node scripts/registerRubricTemplates.js --from old/rubricTemplates.mjs --note "git 4663498"
 *                                                      # list the versions in an older copy
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { rubricFingerprint } = require('../utils/templateUsage');

const REGISTRY_FILE = path.join(__dirname, '..', 'utils', 'rubricTemplateFingerprints.json');
const CLIENT_TEMPLATES = path.join(__dirname, '..', '..', 'client', 'src', 'data', 'rubricTemplates.js');

/**
 * The registry with every template in `mod` (the client module's exports) listed.
 * Returns { registry, added: [{ key, version, fingerprint }] }; the input is not changed.
 */
function registerTemplates(current, mod, { note = null } = {}) {
  const registry = JSON.parse(JSON.stringify(current));
  const labels = Object.fromEntries((mod.getTemplateOptions?.() || [])
    .map((o) => [o.value, o.label.replace(/^[^\p{L}\p{N}]+/u, '').trim()]));
  const added = [];
  for (const [key, template] of Object.entries(mod.rubricTemplates)) {
    const fingerprint = rubricFingerprint(template.criteria, template.forbiddenContent || template.forbidden_content);
    const known = Object.values(registry.templates).some((t) => t.versions.some((v) => v.fingerprint === fingerprint));
    const entry = registry.templates[key] ||= { label: labels[key] || template.title, criteriaIds: [], versions: [] };
    if (labels[key]) entry.label = labels[key];
    if (known) continue;
    const tag = /\(([a-z0-9-]+-v\d+)\)\s*$/i.exec(template.title || '')?.[1];
    const version = tag || `${key}-v${entry.versions.length + 1}`;
    // The newest version's ids decide which rubrics count as a modified copy.
    entry.criteriaIds = template.criteria.map((c) => c.id);
    entry.versions.push({ version, fingerprint, ...(note && { note }) });
    added.push({ key, version, fingerprint });
  }
  return { registry, added };
}

async function main() {
  const argv = process.argv.slice(2);
  const getOpt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const from = getOpt('from') ? path.resolve(getOpt('from')) : CLIENT_TEMPLATES;
  const mod = await import(pathToFileURL(from).href);
  const current = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  const { registry, added } = registerTemplates(current, mod, { note: getOpt('note') });

  for (const a of added) console.log(`${a.key}: ${a.version} (${a.fingerprint})`);
  if (argv.includes('--check')) {
    if (added.length) {
      console.error(`${added.length} template version(s) not listed. Run: node scripts/registerRubricTemplates.js`);
      process.exit(1);
    }
    console.log('Every template version is listed.');
    return;
  }
  if (!added.length) {
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

module.exports = { registerTemplates };
