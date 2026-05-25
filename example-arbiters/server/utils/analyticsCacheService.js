/**
 * Analytics Cache Service
 * Simple in-memory cache with TTL for analytics data
 */

const logger = require('./logger');

class AnalyticsCacheService {
  constructor(ttlMs = 2 * 60 * 1000) { // 2 minutes default
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  /**
   * Get cached data if valid
   * @param {string} key - Cache key
   * @returns {object|null} - Cached data or null if expired/missing
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    const age = Date.now() - entry.timestamp;
    if (age > this.ttlMs) {
      this.cache.delete(key);
      logger.info('Cache expired', { key, ageMs: age });
      return null;
    }

    logger.info('Cache hit', { key, ageMs: age });
    return {
      data: entry.data,
      timestamp: entry.timestamp,
      ageMs: age
    };
  }

  /**
   * Store data in cache
   * @param {string} key - Cache key
   * @param {object} data - Data to cache
   */
  set(key, data) {
    const timestamp = Date.now();
    this.cache.set(key, { data, timestamp });
    logger.info('Cache set', { key });
  }

  /**
   * Invalidate a cache entry
   * @param {string} key - Cache key to invalidate
   */
  invalidate(key) {
    this.cache.delete(key);
    logger.info('Cache invalidated', { key });
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
    logger.info('Cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {object} - Cache stats
   */
  getStats() {
    return {
      size: this.cache.size,
      ttlMs: this.ttlMs,
      keys: Array.from(this.cache.keys())
    };
  }
}

// Singleton instance
const analyticsCache = new AnalyticsCacheService();

module.exports = {
  analyticsCache,
  AnalyticsCacheService
};
