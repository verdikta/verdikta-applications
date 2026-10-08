'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { getAddress, ZeroAddress } = require('ethers');
const QUESTS = ['Q3', 'Q4', 'Q5', 'Q6', 'Q8', 'Q9', 'Q10', 'Q14', 'Q15'];
const CASH_QUESTS = ['Q4', 'Q6', 'Q10'];
const TEMPLATE_IDS = [
  'source-check-v1',
  'evidence-pack-v1',
  'review-v1',
  'real-world-task-v1',
];
const DAY = 86400;
const address = (value) => getAddress(value).toLowerCase();
const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
const digest = (value) => sha256(JSON.stringify(value));
function canonicalRubric(rubric) {
  return {
    title: rubric.title,
    criteria: rubric.criteria.map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      must: !!criterion.must,
      weight: Number(criterion.weight),
      description: criterion.description ?? criterion.instructions,
    })),
    forbiddenContent: rubric.forbiddenContent ?? rubric.forbidden_content ?? [],
  };
}
function snapshotDigest(snapshot) {
  return digest({
    id: snapshot.id,
    version: snapshot.version,
    rubric: canonicalRubric(snapshot.rubric),
    threshold: snapshot.threshold,
  });
}
function validateConfig(input, secret) {
  const config = structuredClone(input);
  const requireField = (valid, field) => {
    if (!valid) throw new Error(`Invalid campaign configuration: ${field}`);
  };
  for (const field of [
    'id',
    'communityId',
    'subdomain',
    'stateDirectory',
    'exceptionsFile',
  ]) {
    requireField(
      typeof config[field] === 'string' &&
        config[field].length > 0 &&
        !config[field].includes('REPLACE'),
      field,
    );
  }
  requireField(
    typeof secret === 'string' && secret.length >= 32,
    'ZEALY_API_KEY',
  );
  requireField(
    typeof config.start === 'string' &&
      /Z$/.test(config.start) &&
      Number.isFinite(Date.parse(config.start)),
    'start (UTC)',
  );
  config.startAt = Date.parse(config.start) / 1000;
  config.endAt = config.startAt + 21 * DAY;
  config.claimEndAt = config.endAt + 3 * DAY;
  requireField(
    typeof config.minimumWei === 'string' &&
      /^[1-9][0-9]*$/.test(config.minimumWei),
    'minimumWei',
  );
  config.minimumWindowHours ??= 4;
  config.maximumWindowHours ??= 336;
  requireField(
    Number.isFinite(config.minimumWindowHours) && config.minimumWindowHours > 0,
    'minimumWindowHours',
  );
  requireField(
    Number.isFinite(config.maximumWindowHours) &&
      config.maximumWindowHours >= config.minimumWindowHours,
    'maximumWindowHours',
  );
  for (const field of [
    'confirmations',
    'maxAgeSeconds',
    'pollSeconds',
    'logChunkSize',
  ]) {
    requireField(
      Number.isSafeInteger(config[field]) && config[field] > 0,
      field,
    );
  }
  requireField(
    config.pollSeconds < config.maxAgeSeconds && config.logChunkSize <= 10000,
    'polling bounds',
  );
  requireField(
    config.teamWalletsReviewed === true && Array.isArray(config.teamWallets),
    'reviewed team exclusions',
  );
  config.teamWallets = [...new Set(config.teamWallets.map(address))].sort();
  config.priorWallets ??= { creators: [], hunters: [] };
  for (const role of ['creators', 'hunters']) {
    requireField(
      Array.isArray(config.priorWallets[role]),
      `priorWallets.${role}`,
    );
    config.priorWallets[role] = [
      ...new Set(config.priorWallets[role].map(address)),
    ].sort();
  }
  const deployment = config.deployment;
  requireField(
    deployment?.chainId === 8453,
    'single production Base deployment',
  );
  requireField(
    Number.isSafeInteger(deployment.fromBlock) && deployment.fromBlock >= 0,
    'deployment.fromBlock',
  );
  requireField(
    /^0x[0-9a-fA-F]{64}$/.test(deployment.codeHash),
    'deployment.codeHash',
  );
  requireField(
    address(deployment.address) !== ZeroAddress,
    'deployment.address',
  );
  config.deployment = {
    chainId: 8453,
    address: address(deployment.address),
    fromBlock: deployment.fromBlock,
    codeHash: deployment.codeHash.toLowerCase(),
  };
  requireField(
    QUESTS.every(
      (quest) =>
        typeof config.quests?.[quest] === 'string' &&
        /^[0-9a-f-]{36}$/i.test(config.quests[quest]),
    ),
    'quest UUIDs',
  );
  requireField(
    Object.keys(config.quests).length === QUESTS.length &&
      new Set(Object.values(config.quests)).size === QUESTS.length,
    'unique quest IDs',
  );
  requireField(
    Array.isArray(config.approvedTemplates) &&
      config.approvedTemplates.length > 0,
    'approvedTemplates',
  );
  for (const snapshot of config.approvedTemplates) {
    requireField(
      TEMPLATE_IDS.includes(snapshot.id) &&
        typeof snapshot.version === 'string' &&
        snapshot.version.length > 0,
      'snapshot identity',
    );
    requireField(
      Array.isArray(snapshot.rubric?.criteria) &&
        snapshot.rubric.criteria.length > 0,
      'snapshot rubric',
    );
    requireField(
      Number.isInteger(snapshot.threshold) &&
        snapshot.threshold >= 0 &&
        snapshot.threshold <= 100,
      'snapshot threshold',
    );
    requireField(
      snapshot.sha256 === snapshotDigest(snapshot),
      'snapshot sha256',
    );
  }
  // Operational settings and file paths must not reset durable campaign identity.
  const policy = {};
  for (const field of [
    'id',
    'communityId',
    'subdomain',
    'start',
    'minimumWei',
    'minimumWindowHours',
    'maximumWindowHours',
    'teamWallets',
    'quests',
    'approvedTemplates',
    'deployment',
    'priorWallets',
  ]) {
    policy[field] = config[field];
  }
  config.policyHash = digest(policy);
  return config;
}
function loadConfig(environment = process.env) {
  if (!environment.ZEALY_CAMPAIGN_CONFIG) return null;
  return validateConfig(
    JSON.parse(fs.readFileSync(environment.ZEALY_CAMPAIGN_CONFIG, 'utf8')),
    environment.ZEALY_API_KEY,
  );
}
module.exports = {
  validateConfig,
  loadConfig,
  QUESTS,
  CASH_QUESTS,
  DAY,
  address,
  digest,
  sha256,
  canonicalRubric,
  snapshotDigest,
};
