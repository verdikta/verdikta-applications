/**
 * LocalStorage service for managing user's saved rubrics
 * Storage key format: `rubrics_{walletAddress}`
 */

const STORAGE_PREFIX = 'verdikta_bounty_rubrics_';

/**
 * Get storage key for a wallet address
 */
const getStorageKey = (walletAddress) => {
  if (!walletAddress) throw new Error('Wallet address required');
  return `${STORAGE_PREFIX}${walletAddress.toLowerCase()}`;
};

/**
 * Get all saved rubrics for a wallet
 * @param {string} walletAddress - Wallet address
 * @returns {Array} Array of saved rubric metadata
 */
export const getSavedRubrics = (walletAddress) => {
  try {
    const key = getStorageKey(walletAddress);
    const data = localStorage.getItem(key);
    
    if (!data) return [];
    
    const rubrics = JSON.parse(data);
    
    // Sort by createdAt (newest first)
    return rubrics.sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.error('Error loading saved rubrics:', error);
    return [];
  }
};

/**
 * Save a new rubric
 * @param {string} walletAddress - Wallet address
 * @param {Object} rubricMetadata - { cid, title, threshold, rubricJson }
 * @returns {boolean} Success
 */
export const saveRubric = (walletAddress, rubricMetadata) => {
  try {
    const { cid, title, threshold, rubricJson } = rubricMetadata;
    
    if (!cid || !title) {
      throw new Error('CID and title are required');
    }
    
    const key = getStorageKey(walletAddress);
    const existing = getSavedRubrics(walletAddress);
    
    // Check for duplicate CID
    const duplicate = existing.find(r => r.cid === cid);
    if (duplicate) {
      throw new Error('This rubric is already saved');
    }
    
    // Add new rubric (threshold stored separately from rubric JSON)
    const newRubric = {
      cid,
      title,
      threshold: threshold || 80, // Store threshold for smart contract use
      criteriaCount: rubricJson.criteria?.length || 0,
      createdAt: Date.now(),
      usedCount: 0
    };
    
    const updated = [newRubric, ...existing];
    
    localStorage.setItem(key, JSON.stringify(updated));
    
    console.log('✅ Rubric saved to localStorage:', { cid, title, threshold });
    
    return true;
  } catch (error) {
    console.error('Error saving rubric:', error);
    throw error;
  }
};

/**
 * Delete a saved rubric by CID
 * @param {string} walletAddress - Wallet address
 * @param {string} cid - Rubric CID to delete
 * @returns {boolean} Success
 */
export const deleteRubric = (walletAddress, cid) => {
  try {
    const key = getStorageKey(walletAddress);
    const existing = getSavedRubrics(walletAddress);
    
    const filtered = existing.filter(r => r.cid !== cid);
    
    if (filtered.length === existing.length) {
      throw new Error('Rubric not found');
    }
    
    localStorage.setItem(key, JSON.stringify(filtered));
    
    console.log('🗑️ Rubric deleted:', cid);
    
    return true;
  } catch (error) {
    console.error('Error deleting rubric:', error);
    throw error;
  }
};

/**
 * Increment usage count for a rubric
 * @param {string} walletAddress - Wallet address
 * @param {string} cid - Rubric CID
 */
export const incrementUsageCount = (walletAddress, cid) => {
  try {
    const key = getStorageKey(walletAddress);
    const existing = getSavedRubrics(walletAddress);
    
    const updated = existing.map(r => 
      r.cid === cid 
        ? { ...r, usedCount: (r.usedCount || 0) + 1, lastUsed: Date.now() }
        : r
    );
    
    localStorage.setItem(key, JSON.stringify(updated));
  } catch (error) {
    console.error('Error updating usage count:', error);
  }
};

/**
 * Check if storage is available
 * @returns {boolean}
 */
export const isStorageAvailable = () => {
  try {
    const test = '__storage_test__';
    localStorage.setItem(test, test);
    localStorage.removeItem(test);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Get storage usage stats
 * @param {string} walletAddress - Wallet address
 * @returns {Object} Stats
 */
export const getStorageStats = (walletAddress) => {
  const rubrics = getSavedRubrics(walletAddress);
  
  return {
    totalRubrics: rubrics.length,
    totalUsage: rubrics.reduce((sum, r) => sum + (r.usedCount || 0), 0),
    mostUsed: rubrics.sort((a, b) => (b.usedCount || 0) - (a.usedCount || 0))[0],
    newest: rubrics[0],
    storageAvailable: isStorageAvailable()
  };
};

export default {
  getSavedRubrics,
  saveRubric,
  deleteRubric,
  incrementUsageCount,
  isStorageAvailable,
  getStorageStats
};

