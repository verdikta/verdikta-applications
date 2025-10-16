#!/usr/bin/env node
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const HEX_ADDR = /^0x[a-fA-F0-9]{40}$/;

// walk any JSON object/array and collect addresses, prioritizing keys containing “bountyescrow”
function findAddressesDeep(obj, pathKeys = []) {
  const hits = [];
  if (obj && typeof obj === "object") {
    // strings that look like addresses
    if (typeof obj === "string" && HEX_ADDR.test(obj)) {
      const joined = pathKeys.join(".");
      const priority = /bountyescrow/i.test(joined) ? 0 : 1;
      hits.push({ addr: obj, priority, where: joined });
    } else if (Array.isArray(obj)) {
      obj.forEach((v, i) => hits.push(...findAddressesDeep(v, pathKeys.concat(String(i)))));
    } else {
      for (const [k, v] of Object.entries(obj)) {
        // common direct shapes
        if (k === "address" && typeof v === "string" && HEX_ADDR.test(v)) {
          const joined = pathKeys.concat(k).join(".");
          const priority = /bountyescrow/i.test(pathKeys.join(".")) ? 0 : 1;
          hits.push({ addr: v, priority, where: joined });
        }
        // keep walking
        hits.push(...findAddressesDeep(v, pathKeys.concat(k)));
      }
    }
  }
  return hits;
}

(async () => {
  const { deployments, network } = hre;
  const netName = network.name;           // e.g. "base_sepolia"
  const chainId = network.config.chainId; // e.g. 84532

  // 1) Canonical hardhat-deploy artifact (works if you used deployments.deploy)
  try {
    const d = await deployments.getOrNull("BountyEscrow");
    if (d?.address && HEX_ADDR.test(d.address)) {
      console.log(d.address);
      return;
    }
  } catch (_) { /* ignore */ }

  // 2) Your custom summary file: deployments/<chainId>-<network>.json
  const summaryPath = path.join(__dirname, "..", "deployments", `${chainId}-${netName}.json`);
  if (!fs.existsSync(summaryPath)) {
    console.error(
      `No BountyEscrow address found for '${netName}'.\n` +
      `Also could not find summary file:\n  ${summaryPath}`
    );
    process.exit(1);
  }

  let raw;
  try {
    raw = fs.readFileSync(summaryPath, "utf8");
  } catch (e) {
    console.error(`Failed to read ${summaryPath}: ${e.message}`);
    process.exit(1);
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to parse ${summaryPath} as JSON: ${e.message}`);
    process.exit(1);
  }

  // 2a) Try several common shapes explicitly
  const candidates = [];

  // { contracts: { BountyEscrow: { address } } }
  if (j?.contracts?.BountyEscrow?.address && HEX_ADDR.test(j.contracts.BountyEscrow.address)) {
    candidates.push(j.contracts.BountyEscrow.address);
  }
  // { contracts: { BountyEscrow: "0x..." } }
  if (typeof j?.contracts?.BountyEscrow === "string" && HEX_ADDR.test(j.contracts.BountyEscrow)) {
    candidates.push(j.contracts.BountyEscrow);
  }
  // { BountyEscrow: { address } }
  if (j?.BountyEscrow?.address && HEX_ADDR.test(j.BountyEscrow.address)) {
    candidates.push(j.BountyEscrow.address);
  }
  // { BountyEscrow: "0x..." }
  if (typeof j?.BountyEscrow === "string" && HEX_ADDR.test(j.BountyEscrow)) {
    candidates.push(j.BountyEscrow);
  }
  // { addresses: { BountyEscrow: "0x..." } }
  if (typeof j?.addresses?.BountyEscrow === "string" && HEX_ADDR.test(j.addresses.BountyEscrow)) {
    candidates.push(j.addresses.BountyEscrow);
  }
  // flat { address: "0x..." }
  if (j?.address && HEX_ADDR.test(j.address)) {
    candidates.push(j.address);
  }

  if (candidates.length > 0) {
    console.log(candidates[0]);
    return;
  }

  // 2b) Deep scan fallback (priority to keys mentioning "BountyEscrow")
  const deep = findAddressesDeep(j).sort((a, b) => a.priority - b.priority);
  if (deep.length > 0) {
    console.log(deep[0].addr);
    return;
  }

  console.error(
    `No BountyEscrow address found for '${netName}'.\n` +
    `Looked for hardhat-deploy artifact and '${summaryPath}'.\n` +
    `Tip: open the file and check where the address lives, or paste its structure.`
  );
  process.exit(1);
})();

