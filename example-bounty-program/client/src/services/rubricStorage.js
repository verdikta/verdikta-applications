/**
 * LocalStorage service for managing user's saved rubrics
 * Supports both legacy and new call signatures.
 *
 * Storage keys (network-aware to support multi-network deployments):
 *   Per-wallet:  verdikta_bounty_rubrics_<network>_<lowercased_wallet>
 *   Global:      verdikta_bounty_rubrics_<network>_global  (fallback when wallet is unknown)
 */

import { config } from '../config';

// Network-aware storage keys to prevent cross-network data contamination
const NETWORK = config.network || 'base-sepolia';
const STORAGE_PREFIX = `verdikta_bounty_rubrics_${NETWORK}_`;
const GLOBAL_KEY = `verdikta_bounty_rubrics_${NETWORK}_global`;

// ---------- internal helpers ----------

const isStorageAvailable = () => {
  try {
    const test = '__storage_test__';
    localStorage.setItem(test, test);
    localStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
};

// 0x... (40 hex) check (case-insensitive)
const isEthAddress = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);

// Normalize to a storage key; fall back to GLOBAL_KEY if wallet is absent/invalid.
const getStorageKey = (walletAddress) => {
  if (isEthAddress(walletAddress)) return `${STORAGE_PREFIX}${walletAddress.toLowerCase()}`;
  return GLOBAL_KEY;
};

// Parse timestamps safely to a number
const toTimestamp = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : Date.now();
  }
  return Date.now();
};

// Normalize a saved rubric entry (for sorting + display)
const normalizeEntry = (e) => {
  if (!e || typeof e !== 'object') return null;
  // Keep legacy fields, add fallbacks
  const createdAt = toTimestamp(e.createdAt);
  const criteria = Array.isArray(e.criteria) ? e.criteria : [];
  return {
    cid: e.cid,
    title: e.title || '(untitled rubric)',
    description: e.description || '',
    threshold: Number.isFinite(e.threshold) ? e.threshold : 80,
    criteriaCount: Number.isFinite(e.criteriaCount) ? e.criteriaCount : criteria.length,
    criteria,                     // keep full criteria if present (helps library)
    classId: Number.isFinite(e.classId) ? e.classId : undefined,
    createdAt,
    usedCount: Number.isFinite(e.usedCount) ? e.usedCount : 0,
    lastUsed: e.lastUsed ? toTimestamp(e.lastUsed) : undefined,
  };
};

// Read array for a wallet/global; returns [] on any read/parse issue
const readList = (walletAddress) => {
  if (!isStorageAvailable()) return [];
  try {
    const key = getStorageKey(walletAddress);
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(normalizeEntry)
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    console.error('[rubricStorage] readList failed:', e);
    return [];
  }
};

// Write array for a wallet/global
const writeList = (walletAddress, list) => {
  if (!isStorageAvailable()) throw new Error('LocalStorage not available');
  const key = getStorageKey(walletAddress);
  localStorage.setItem(key, JSON.stringify(list));
};

// ---------- public API ----------

/**
 * Get all saved rubrics for a wallet (or global if wallet is missing/invalid)
 * @param {string} walletAddress
 * @returns {Array} normalized rubric entries (newest first)
 */
export const getSavedRubrics = (walletAddress) => readList(walletAddress);

/**
 * Save a rubric.
 *
 * Accepted signatures:
 *  - saveRubric(walletAddress, rubricMetadata)
 *  - saveRubric(rubricMetadata) // wallet inferred from rubricMetadata.creator
 *
 * rubricMetadata expected fields:
 *  - cid (required)
 *  - title (required)
 *  - description? (string)
 *  - criteria? (array)
 *  - threshold? (number)
 *  - classId? (number)
 *  - createdAt? (string | number)
 *  - creator? (0x-address; used to pick per-wallet key if first arg missing)
 *
 * Throws on validation or storage failure.
 * Returns true on success.
 */
export const saveRubric = (...args) => {
  let walletAddress = null;
  let meta = null;

  if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'object') {
    // Legacy: (walletAddress, meta)
    walletAddress = args[0];
    meta = args[1];
  } else if (args.length === 1 && typeof args[0] === 'object') {
    // New: (meta), wallet inferred from meta.creator
    meta = args[0];
    walletAddress = meta?.creator || null;
  } else {
    throw new Error('Invalid saveRubric arguments');
  }

  if (!meta || typeof meta !== 'object') throw new Error('rubricMetadata is required');
  const { cid, title } = meta;
  if (!cid || !title) throw new Error('CID and title are required');

  // Build normalized entry to store
  const criteria = Array.isArray(meta.criteria) ? meta.criteria : (meta.rubricJson?.criteria || []);
  const entry = normalizeEntry({
    cid,
    title,
    description: meta.description || '',
    threshold: Number.isFinite(meta.threshold) ? meta.threshold : 80,
    criteria,
    criteriaCount: criteria.length,
    classId: Number.isFinite(meta.classId) ? meta.classId : undefined,
    createdAt: meta.createdAt || Date.now(),
    usedCount: Number.isFinite(meta.usedCount) ? meta.usedCount : 0,
    lastUsed: meta.lastUsed || undefined,
  });

  // Persist
  const list = readList(walletAddress);
  if (list.some((r) => r.cid === entry.cid)) {
    // Avoid duplicates; treat as success (idempotent)
    return true;
  }
  const updated = [entry, ...list].slice(0, 200); // cap to avoid unbounded growth
  writeList(walletAddress, updated);
  console.log('✅ [rubricStorage] Saved:', { key: getStorageKey(walletAddress), cid: entry.cid, title: entry.title });
  return true;
};

/**
 * Delete a saved rubric by CID (wallet-specific if provided; otherwise global)
 * @param {string} walletAddress
 * @param {string} cid
 * @returns {boolean}
 */
export const deleteRubric = (walletAddress, cid) => {
  if (!cid) throw new Error('CID required');
  const list = readList(walletAddress);
  const filtered = list.filter((r) => r.cid !== cid);
  if (filtered.length === list.length) throw new Error('Rubric not found');
  writeList(walletAddress, filtered);
  console.log('🗑️ [rubricStorage] Deleted:', { key: getStorageKey(walletAddress), cid });
  return true;
};

/**
 * Increment usage count for a rubric (wallet-specific if provided; otherwise global)
 * @param {string} walletAddress
 * @param {string} cid
 */
export const incrementUsageCount = (walletAddress, cid) => {
  try {
    const list = readList(walletAddress);
    const updated = list.map((r) =>
      r.cid === cid ? { ...r, usedCount: (r.usedCount || 0) + 1, lastUsed: Date.now() } : r
    );
    writeList(walletAddress, updated);
  } catch (e) {
    console.error('[rubricStorage] incrementUsageCount failed:', e);
  }
};

/**
 * Check if storage is available
 * @returns {boolean}
 */
export { isStorageAvailable };

/**
 * Get storage usage stats (wallet-specific if provided; otherwise global)
 * @param {string} walletAddress
 * @returns {Object}
 */
export const getStorageStats = (walletAddress) => {
  const rubrics = readList(walletAddress);
  const mostUsed = [...rubrics].sort((a, b) => (b.usedCount || 0) - (a.usedCount || 0))[0];
  return {
    totalRubrics: rubrics.length,
    totalUsage: rubrics.reduce((sum, r) => sum + (r.usedCount || 0), 0),
    mostUsed: mostUsed || null,
    newest: rubrics[0] || null,
    storageAvailable: isStorageAvailable(),
  };
};

export default {
  getSavedRubrics,
  saveRubric,
  deleteRubric,
  incrementUsageCount,
  isStorageAvailable,
  getStorageStats,
};

