const fs = require("fs");
const path = require("path");

function outPath(network, chainId) {
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return path.join(dir, `${chainId}-${network}.json`);
}

function saveDeployment(network, chainId, data) {
  const file = outPath(network, chainId);
  // Handle BigInt serialization
  const jsonData = JSON.stringify(data, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  , 2);
  fs.writeFileSync(file, jsonData);
  console.log(`\n📝 Saved deployment to ${file}\n`);
}

function copyAbiToFrontend(artifactName, destRel = "frontend/src/abi") {
  try {
    // Use the artifactName parameter to construct the correct path
    const src = path.join(__dirname, "..", "artifacts", "contracts", `${artifactName}.sol`, `${artifactName}.json`);
    const destDir = path.join(__dirname, "..", destRel);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${artifactName}.json`);
    fs.copyFileSync(src, dest);
    console.log(`Copied ABI to ${dest}`);
  } catch (e) {
    console.log("Skipped ABI copy (frontend path not found).");
  }
}

module.exports = { saveDeployment, copyAbiToFrontend };

