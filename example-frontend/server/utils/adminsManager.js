// server/utils/adminsManager.js
const fs = require('fs').promises;
const path = require('path');

// Path to the admins data file
const ADMINS_FILE_PATH = path.resolve(__dirname, '../data/admins.json');
const DATA_DIR = path.dirname(ADMINS_FILE_PATH);

/**
 * Validates an Ethereum address using regex
 * @param {string} address - The address to validate
 * @returns {boolean} True if address is valid
 */
function isValidEthereumAddress(address) {
  const ethereumAddressRegex = /^0x[a-fA-F0-9]{40}$/;
  return ethereumAddressRegex.test(address);
}

/**
 * Ensures the data directory exists
 * @returns {Promise<void>}
 */
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    console.log(`Data directory ensured at: ${DATA_DIR}`);
    return true;
  } catch (error) {
    console.error('Error creating data directory:', error);
    throw new Error(`Failed to create data directory: ${error.message}`);
  }
}

/**
 * Loads bootstrap admin addresses from environment variable
 * @returns {Array} Array of bootstrap admin addresses
 */
function getBootstrapAdmins() {
  const adminAddresses = process.env.ADMIN_ADDRESSES || '';
  if (!adminAddresses) {
    console.warn('No ADMIN_ADDRESSES found in .env - no bootstrap admins configured');
    return [];
  }

  return adminAddresses
    .split(',')
    .map(addr => addr.trim().toLowerCase())
    .filter(addr => isValidEthereumAddress(addr));
}

/**
 * Loads admins from admins.json file
 * Combines bootstrap admins from .env with database admins
 * @returns {Promise<Object>} Object with bootstrap and regular admins
 */
async function loadAdmins() {
  try {
    await ensureDataDir();

    // Get bootstrap admins from .env
    const bootstrapAdmins = getBootstrapAdmins();

    let regularAdmins = [];

    try {
      // Check if admins.json exists
      await fs.access(ADMINS_FILE_PATH);

      // Read and parse the file
      const data = await fs.readFile(ADMINS_FILE_PATH, 'utf8');
      const adminsData = JSON.parse(data);

      if (adminsData && adminsData.admins && Array.isArray(adminsData.admins)) {
        regularAdmins = adminsData.admins;
      }
    } catch (error) {
      // File doesn't exist or can't be parsed - initialize with empty array
      console.log('admins.json does not exist or is invalid, will create with bootstrap admins only');

      // Create initial file with bootstrap admins
      const initialData = {
        admins: [],
        lastUpdated: new Date().toISOString()
      };

      await fs.writeFile(ADMINS_FILE_PATH, JSON.stringify(initialData, null, 2));
    }

    return {
      bootstrap: bootstrapAdmins,
      regular: regularAdmins,
      all: [...bootstrapAdmins, ...regularAdmins.map(a => a.address.toLowerCase())]
    };
  } catch (error) {
    console.error('Error loading admins:', error);
    // Return at least bootstrap admins in case of error
    const bootstrapAdmins = getBootstrapAdmins();
    return {
      bootstrap: bootstrapAdmins,
      regular: [],
      all: bootstrapAdmins
    };
  }
}

/**
 * Checks if an address is an admin
 * @param {string} address - Address to check
 * @returns {Promise<Object>} Object with isAdmin, isBootstrap flags
 */
async function isAdmin(address) {
  if (!isValidEthereumAddress(address)) {
    return { isAdmin: false, isBootstrap: false };
  }

  const admins = await loadAdmins();
  const normalizedAddress = address.toLowerCase();

  const isBootstrap = admins.bootstrap.includes(normalizedAddress);
  const isRegular = admins.regular.some(a => a.address.toLowerCase() === normalizedAddress);

  return {
    isAdmin: isBootstrap || isRegular,
    isBootstrap
  };
}

/**
 * Adds a new admin to the database
 * @param {string} address - Address to add
 * @param {string} addedBy - Address of admin who added this admin
 * @returns {Promise<Object>} The added admin object
 */
async function addAdmin(address, addedBy) {
  if (!isValidEthereumAddress(address)) {
    throw new Error(`Invalid Ethereum address: ${address}`);
  }

  if (!isValidEthereumAddress(addedBy)) {
    throw new Error(`Invalid addedBy address: ${addedBy}`);
  }

  const admins = await loadAdmins();
  const normalizedAddress = address.toLowerCase();

  // Check if already exists
  if (admins.all.includes(normalizedAddress)) {
    throw new Error('Address is already an admin');
  }

  // Create new admin object
  const newAdmin = {
    address: normalizedAddress,
    addedBy: addedBy.toLowerCase(),
    addedAt: new Date().toISOString()
  };

  // Add to regular admins
  const updatedAdmins = [...admins.regular, newAdmin];

  // Save to file
  await saveAdmins(updatedAdmins);

  return newAdmin;
}

/**
 * Removes an admin from the database
 * Bootstrap admins cannot be removed
 * @param {string} address - Address to remove
 * @returns {Promise<boolean>} Success status
 */
async function removeAdmin(address) {
  if (!isValidEthereumAddress(address)) {
    throw new Error(`Invalid Ethereum address: ${address}`);
  }

  const admins = await loadAdmins();
  const normalizedAddress = address.toLowerCase();

  // Check if this is a bootstrap admin
  if (admins.bootstrap.includes(normalizedAddress)) {
    throw new Error('Cannot remove bootstrap admin. Remove from ADMIN_ADDRESSES in .env instead.');
  }

  // Filter out the admin
  const updatedAdmins = admins.regular.filter(
    a => a.address.toLowerCase() !== normalizedAddress
  );

  // Check if anything was removed
  if (updatedAdmins.length === admins.regular.length) {
    throw new Error('Admin not found');
  }

  // Save to file
  await saveAdmins(updatedAdmins);

  return true;
}

/**
 * Saves admins to the admins.json file
 * @param {Array} admins - Array of admin objects
 * @returns {Promise<boolean>} Success status
 */
async function saveAdmins(admins) {
  try {
    await ensureDataDir();

    const data = {
      admins,
      lastUpdated: new Date().toISOString()
    };

    await fs.writeFile(ADMINS_FILE_PATH, JSON.stringify(data, null, 2));
    console.log(`Saved ${admins.length} admins to ${ADMINS_FILE_PATH}`);

    return true;
  } catch (error) {
    console.error('Error saving admins:', error);
    throw new Error(`Failed to save admins: ${error.message}`);
  }
}

module.exports = {
  loadAdmins,
  isAdmin,
  addAdmin,
  removeAdmin,
  saveAdmins,
  isValidEthereumAddress
};
