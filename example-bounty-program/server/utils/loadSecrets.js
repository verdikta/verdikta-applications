'use strict';
// Loads the shared secrets file into process.env, except deploy and owner keys.
//
// The file /root/verdikta/secrets/.env.secrets is also where the Hardhat deploy configs read
// PRIVATE_KEY and PRIVATE_KEY_2 (dispatcher/reputationBasedAggregator/hardhat.config.js,
// example-bounty-program/onchain/hardhat.config.js), and a deployer is the contracts' owner. No
// server code uses those keys (the CLI scripts under scripts/ load the file themselves), so a web
// server never holds them: an RCE in it, or in any of its dependencies, which all read process.env,
// would otherwise get the aggregator's and keeper's owner key. The keeper's own KEEPER_PRIVATE_KEY
// is a different key, which this server does use, and stays.
const fs = require('fs');
const dotenv = require('dotenv');

const DEPLOY_KEY = /^(PRIVATE_KEY(_\d+)?|MNEMONIC|DEPLOYER_PRIVATE_KEY|OWNER_PRIVATE_KEY)$/;

/**
 * @param {string} file the secrets file
 * @param {{ override?: boolean }} opts override: its values replace ones already in process.env
 * @returns {{ parsed?: object, error?: Error, dropped: string[] }} as dotenv.config, plus the names dropped
 */
function loadSecrets(file, { override = false } = {}) {
  const dropped = new Set();
  let parsed;
  let error;
  try {
    parsed = dotenv.parse(fs.readFileSync(file));
  } catch (e) {
    error = e;
  }
  for (const [k, v] of Object.entries(parsed || {})) {
    if (DEPLOY_KEY.test(k)) { dropped.add(k); continue; }
    if (override || !Object.prototype.hasOwnProperty.call(process.env, k)) process.env[k] = v;
  }
  // and the same names from anywhere else (a local .env, the unit)
  for (const k of Object.keys(process.env)) {
    if (DEPLOY_KEY.test(k)) { delete process.env[k]; dropped.add(k); }
  }
  return { parsed, error, dropped: [...dropped] };
}

module.exports = { loadSecrets, DEPLOY_KEY };
