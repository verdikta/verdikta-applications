import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SUBMISSION_WINDOW_HOURS,
  campaignFromSearch,
  ethToWei,
  campaignEligibility,
} from '../../src/utils/campaignCreate.js';

test('default submission window is 48 hours', () => {
  assert.equal(DEFAULT_SUBMISSION_WINDOW_HOURS, 48);
});

test('campaign lookup accepts only known ids', () => {
  assert.equal(campaignFromSearch('bring-a-task').payoutAmountEth, '0.0041');
  assert.equal(campaignFromSearch(' Bring-A-Task ').id, 'bring-a-task');
  assert.equal(campaignFromSearch('other'), null);
  assert.equal(campaignFromSearch(null), null);
});

test('ethToWei is exact for the campaign minimum and rejects junk', () => {
  assert.equal(ethToWei('0.0041'), 4100000000000000n);
  assert.equal(ethToWei('1'), 10n ** 18n);
  assert.equal(ethToWei('0.00409999'), 4099990000000000n);
  assert.equal(ethToWei('abc'), null);
  assert.equal(ethToWei(''), null);
  assert.equal(ethToWei('1e3'), null);
});

test('eligibility rows follow the campaign rules', () => {
  const campaign = campaignFromSearch('bring-a-task');
  const good = campaignEligibility(campaign, { payoutAmount: '0.0041', submissionWindowHours: 48, targetHunter: '' });
  assert.deepEqual(good.map((r) => [r.id, r.ok]), [['wallet', null], ['open', true], ['minimum', true], ['window', true]]);

  const bad = campaignEligibility(campaign, {
    payoutAmount: '0.004',
    submissionWindowHours: 2,
    targetHunter: '0x1111111111111111111111111111111111111111',
  });
  assert.deepEqual(bad.map((r) => [r.id, r.ok]), [['wallet', null], ['open', false], ['minimum', false], ['window', false]]);
  assert.match(bad.find((r) => r.id === 'minimum').text, /at least 0\.0041 ETH/);
  assert.match(bad.find((r) => r.id === 'window').text, /4 hours and 14 days/);

  const edges = campaignEligibility(campaign, { payoutAmount: '0.0041', submissionWindowHours: '336', targetHunter: '' });
  assert.equal(edges.find((r) => r.id === 'window').ok, true);
  assert.equal(campaignEligibility(campaign, { payoutAmount: '0.0041', submissionWindowHours: 337 }).find((r) => r.id === 'window').ok, false);
  assert.deepEqual(campaignEligibility(null, {}), []);
});
