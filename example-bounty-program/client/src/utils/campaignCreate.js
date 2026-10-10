// Campaign-aware defaults for the Create Bounty page.
//
// `/create?campaign=bring-a-task` prefills the reward and window that the
// "Bring a Task, Build a Habit" Zealy campaign requires and shows a live
// eligibility checklist. The server and the campaign verifier remain
// authoritative; this only prevents avoidable mistakes before funding.

export const DEFAULT_SUBMISSION_WINDOW_HOURS = 48;

export const CAMPAIGNS = {
  'bring-a-task': {
    id: 'bring-a-task',
    label: 'Bring a Task, Build a Habit',
    payoutAmountEth: '0.0041',
    minimumRewardEth: '0.0041',
    minimumWindowHours: 4,
    maximumWindowHours: 336,
    recommendedWindowHours: 48,
  },
};

export function campaignFromSearch(value) {
  if (typeof value !== 'string') return null;
  return CAMPAIGNS[value.trim().toLowerCase()] || null;
}

// Exact decimal ETH string -> wei BigInt, or null when the text is not a plain decimal.
export function ethToWei(text) {
  const match = /^\s*(\d+)(?:\.(\d{1,18}))?\s*$/.exec(String(text ?? ''));
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

// Returns checklist rows: { id, ok: true | false | null, text }. `ok === null`
// marks a reminder the browser cannot verify.
export function campaignEligibility(campaign, form) {
  if (!campaign) return [];
  const rows = [];
  rows.push({
    id: 'wallet',
    ok: null,
    text: 'Fund from the same ordinary wallet address you connected to Zealy (not a smart-contract wallet).',
  });
  const target = String(form.targetHunter || '').trim();
  rows.push({
    id: 'open',
    ok: target === '',
    text: target === ''
      ? 'Open to any hunter (no target address).'
      : 'Remove the target address: campaign bounties must be open to any hunter.',
  });
  const payoutWei = ethToWei(form.payoutAmount);
  const minimumWei = ethToWei(campaign.minimumRewardEth);
  const meetsMinimum = payoutWei !== null && payoutWei >= minimumWei;
  rows.push({
    id: 'minimum',
    ok: meetsMinimum,
    text: meetsMinimum
      ? `Reward is at least ${campaign.minimumRewardEth} ETH.`
      : `Reward must be at least ${campaign.minimumRewardEth} ETH.`,
  });
  const hours = Number(form.submissionWindowHours);
  const windowOk = Number.isFinite(hours)
    && hours >= campaign.minimumWindowHours
    && hours <= campaign.maximumWindowHours;
  rows.push({
    id: 'window',
    ok: windowOk,
    text: windowOk
      ? `Submission window is between ${campaign.minimumWindowHours} hours and ${campaign.maximumWindowHours / 24} days.`
      : `Submission window must be between ${campaign.minimumWindowHours} hours and ${campaign.maximumWindowHours / 24} days (${campaign.recommendedWindowHours} recommended).`,
  });
  return rows;
}
