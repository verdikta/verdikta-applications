#!/usr/bin/env node
import './_env.js';
// Minimal worker loop: list open jobs + print titles.
// This is a scaffold; real workers should fetch rubric, do work, then submit.

import fs from 'node:fs/promises';

const baseUrl = process.env.VERDIKTA_BOUNTIES_BASE_URL || 'https://bounties.verdikta.org';
const botFile = process.env.VERDIKTA_BOT_FILE || '../secrets/verdikta-bounties-bot.json';

const raw = await fs.readFile(botFile, 'utf-8');
const j = JSON.parse(raw);
const apiKey = j.apiKey || j.api_key || j.bot?.apiKey || j.bot?.api_key;
if (!apiKey) throw new Error('Missing apiKey/api_key in bot file');

const url = new URL(`${baseUrl}/api/jobs`);
url.searchParams.set('status', 'OPEN');
url.searchParams.set('minHoursLeft', '2');

const resp = await fetch(url, {
  headers: { 'X-Bot-API-Key': apiKey }
});
const data = await resp.json();
if (!resp.ok) throw new Error(`jobs failed: ${resp.status} ${JSON.stringify(data)}`);

for (const job of (data.jobs || [])) {
  console.log(`#${job.jobId}: ${job.title} — $${job.bountyAmountUSD || 0}`);
}
