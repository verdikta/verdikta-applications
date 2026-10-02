#!/usr/bin/env node
// Read-only onboarding smoke check: list open jobs, never submit or sign.
import { isMain } from './_cli.js';
export async function listOpenJobs({baseUrl, apiKey, fetchApi = globalThis.fetch}) {
  if (!baseUrl || !apiKey) throw new Error('Configured API origin and identity required; run authorized onboarding first');
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/jobs`);
  url.searchParams.set('status', 'OPEN');
  url.searchParams.set('minHoursLeft', '2');
  const response = await fetchApi(url, {method:'GET', headers:{'X-Bot-API-Key':apiKey}, redirect:'error'});
  if (!response.ok) throw new Error(`Job listing failed: HTTP ${response.status}`);
  const data = await response.json();
  for (const job of data.jobs || []) console.log(`#${job.jobId}: ${job.title} — $${job.bountyAmountUSD || 0}`);
  return data.jobs || [];
}
if (isMain(import.meta.url)) {
  const {loadApiKey, getNetwork, reviewedApiOrigin} = await import('./_lib.js');
  const apiKey = await loadApiKey();
  await listOpenJobs({baseUrl:reviewedApiOrigin(getNetwork(), process.env.VERDIKTA_BOUNTIES_BASE_URL), apiKey});
}
