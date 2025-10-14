const fs = require("fs");
const path = require("path");

function outPath(network, chainId) {
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return path.join(dir, `${chainId}-${network}.json`);
}

function saveDeployment(network, chainId, data) {
  const file = outPath(network, chainId);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\n📝 Saved deployment to ${file}\n`);
}

function copyAbiToFrontend(artifactName, destRel = "frontend/src/abi") {
  try {
    const src = path.join(__dirname, "..", "artifacts", "contracts", "VerdiktaBountyEscrow.sol", "VerdiktaBountyEscrow.json");
    const destDir = path.join(__dirname, "..", destRel);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${artifactName}.json`);
    fs.copyFileSync(src, dest);
    console.log(`📦 Copied ABI to ${dest}`);
  } catch (e) {
    console.log("ℹ️ Skipped ABI copy (frontend path not found).");
  }
}

module.exports = { saveDeployment, copyAbiToFrontend };

