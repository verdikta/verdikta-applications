#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Script to check for updates to @verdikta/common before building
 * This ensures the application always uses the most up-to-date version
 */

const PACKAGE_NAME = '@verdikta/common';
const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[36m',    // cyan
    success: '\x1b[32m', // green
    warning: '\x1b[33m', // yellow
    error: '\x1b[31m',   // red
    reset: '\x1b[0m'     // reset
  };
  
  console.log(`${colors[type]}[VERDIKTA UPDATE CHECK] ${message}${colors.reset}`);
}

function getCurrentVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return packageJson.dependencies[PACKAGE_NAME];
  } catch (error) {
    log(`Error reading package.json: ${error.message}`, 'error');
    process.exit(1);
  }
}

function getLatestVersion() {
  try {
    log('Checking for latest version of @verdikta/common...');
    const output = execSync(`npm view ${PACKAGE_NAME} version`, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim();
  } catch (error) {
    log(`Error checking latest version: ${error.message}`, 'error');
    log('Continuing with build using current version...', 'warning');
    return null;
  }
}

function getInstalledVersion() {
  try {
    const output = execSync(`npm list ${PACKAGE_NAME} --depth=0 --json`, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const parsed = JSON.parse(output);
    return parsed.dependencies[PACKAGE_NAME]?.version;
  } catch (error) {
    log(`Error checking installed version: ${error.message}`, 'error');
    return null;
  }
}

function compareVersions(current, latest) {
  // Simple version comparison - assumes semantic versioning
  const currentParts = current.replace(/[\^~]/, '').split('.').map(Number);
  const latestParts = latest.split('.').map(Number);
  
  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const currentPart = currentParts[i] || 0;
    const latestPart = latestParts[i] || 0;
    
    if (currentPart < latestPart) return -1;
    if (currentPart > latestPart) return 1;
  }
  return 0;
}

function updatePackage() {
  try {
    log('Updating @verdikta/common to latest version...');
    execSync(`npm install ${PACKAGE_NAME}@latest`, { 
      stdio: 'inherit',
      cwd: path.dirname(PACKAGE_JSON_PATH)
    });
    log('Successfully updated @verdikta/common!', 'success');
    return true;
  } catch (error) {
    log(`Error updating package: ${error.message}`, 'error');
    log('Continuing with build using current version...', 'warning');
    return false;
  }
}

function main() {
  log('Starting @verdikta/common update check...');
  
  const currentVersion = getCurrentVersion();
  const installedVersion = getInstalledVersion();
  const latestVersion = getLatestVersion();
  
  if (!latestVersion) {
    log('Could not determine latest version. Continuing with build...', 'warning');
    return;
  }
  
  log(`Current package.json version: ${currentVersion}`);
  log(`Installed version: ${installedVersion || 'unknown'}`);
  log(`Latest available version: ${latestVersion}`);
  
  // Check if we need to update
  const needsUpdate = compareVersions(currentVersion, latestVersion) < 0;
  
  if (needsUpdate) {
    log(`Update available! ${currentVersion} → ${latestVersion}`, 'warning');
    
    // Auto-update to ensure we have the latest version
    log('Auto-updating to ensure build uses latest version...');
    const updateSuccess = updatePackage();
    
    if (updateSuccess) {
      log('Build will proceed with updated @verdikta/common version', 'success');
    } else {
      log('Build will proceed with current version', 'warning');
    }
  } else {
    log('Already using the latest version!', 'success');
  }
  
  log('Update check complete. Proceeding with build...');
}

// Run the check
main();