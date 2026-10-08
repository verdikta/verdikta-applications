'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { getAddress } = require('ethers');
const QUESTS = ['Q3', 'Q4', 'Q5', 'Q6', 'Q8', 'Q9', 'Q10', 'Q14', 'Q15'];
const DAY = 86400;
const KNOWN_BASE_ESCROWS = [
  '0x0a6290efa369bbd4a9886ab9f98d7fad7b0dc746',
  '0x3970dc3750dde4e73fdcd3a81b66f1472bbaaeee',
  '0x1a4a0deddae20c24c3cd7735a2ab1afdac491770',
  '0x4390820f6f18efef51606434d5a9ed1841cee916',
  '0x2ae271f5e86bee449a36b943414b7c1a7b39772d',
  '0xa741eff41bcf14793e61cebb4179e05c9124d3f6'
];
const address = x => getAddress(x).toLowerCase();
const digest = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function validateConfig(input, secret) {
  const c = structuredClone(input);
  const need = (ok, field) => { if (!ok) throw new Error(`Invalid campaign configuration: ${field}`); };
  for (const k of ['id', 'communityId', 'subdomain', 'stateDirectory']) need(typeof c[k] === 'string' && c[k].length > 0 && !c[k].includes('REPLACE'), k);
  need(typeof secret === 'string' && secret.length >= 32, 'ZEALY_API_KEY (minimum 32 characters)');
  need(typeof c.start === 'string' && /Z$/.test(c.start) && Number.isFinite(Date.parse(c.start)), 'start (UTC)');
  c.startAt = Date.parse(c.start) / 1000; c.endAt = c.startAt + 21 * DAY; c.claimEndAt = c.endAt + 3 * DAY;
  need(/^[1-9][0-9]*$/.test(c.minimumWei), 'minimumWei');
  for (const k of ['confirmations', 'maxAgeSeconds', 'pollSeconds', 'logChunkSize']) need(Number.isSafeInteger(c[k]) && c[k] > 0, k);
  need(c.pollSeconds < c.maxAgeSeconds, 'pollSeconds < maxAgeSeconds');
  need(c.logChunkSize <= 10000, 'logChunkSize <= 10000');
  need(c.teamWalletsReviewed === true && Array.isArray(c.teamWallets), 'explicit reviewed team exclusions');
  c.teamWallets = c.teamWallets.map(address);
  need(typeof c.historyInventoryComplete === 'boolean', 'historyInventoryComplete');
  need(typeof c.historyInventoryEvidence === 'string' && c.historyInventoryEvidence.length > 0 && (!c.historyInventoryComplete || !c.historyInventoryEvidence.includes('REPLACE')), 'historyInventoryEvidence');
  need(Array.isArray(c.deployments) && c.deployments.length > 0, 'deployments');
  c.deployments = c.deployments.map(d => {
    need(d.chainId === 8453, 'production Base chainId');
    need(['v0.5', 'legacy-history'].includes(d.adapter), 'deployment adapter');
    need(Number.isSafeInteger(d.fromBlock) && d.fromBlock >= 0, 'deployment fromBlock');
    need(/^0x[0-9a-fA-F]{64}$/.test(d.codeHash), 'deployment codeHash');
    need(typeof d.campaign === 'boolean' && (!d.campaign || d.adapter === 'v0.5'), 'campaign deployment adapter');
    need(typeof d.evidence === 'string' && d.evidence.length > 0, 'deployment evidence');
    need(address(d.address) !== '0x'+'0'.repeat(40), 'nonzero escrow');
    return { ...d, address: address(d.address) };
  });
  need(c.deployments.some(d => d.campaign), 'campaign deployment');
  need(new Set(c.deployments.map(d => d.address)).size === c.deployments.length, 'duplicate deployment');
  // Known retired production deployment must not disappear under a completeness flag.
  if (c.historyInventoryComplete) need(KNOWN_BASE_ESCROWS.every(a => c.deployments.some(d => d.address === a)), 'known retired Base deployment');
  need(QUESTS.every(q => typeof c.quests?.[q] === 'string' && /^[0-9a-f-]{36}$/i.test(c.quests[q])), 'all quest UUIDs');
  need(new Set(Object.values(c.quests)).size === QUESTS.length && Object.keys(c.quests).length === QUESTS.length, 'unique quest allowlist');
  need(Array.isArray(c.approvedTemplates) && c.approvedTemplates.length > 0, 'approvedTemplates');
  for (const t of c.approvedTemplates) need(['source-check-v1','evidence-pack-v1','review-v1','real-world-task-v1'].includes(t.id) && /^[0-9a-f]{64}$/.test(t.sha256), 'approved template digest');
  c.policyHash = digest(c);
  return c;
}
function loadConfig(env = process.env) {
  if (!env.ZEALY_CAMPAIGN_CONFIG) return null;
  return validateConfig(JSON.parse(fs.readFileSync(env.ZEALY_CAMPAIGN_CONFIG, 'utf8')), env.ZEALY_API_KEY);
}
module.exports = { validateConfig, loadConfig, QUESTS, DAY, address, digest, KNOWN_BASE_ESCROWS };
