// Browser-compatible ClassMap service for consuming backend API
const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:5001';

/**
 * Service for interacting with ClassMap functionality via backend API
 */
export class ClassMapService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache
  }

  /**
   * Get all available classes
   * @param {Object} filter - Optional filter {status?, provider?}
   * @returns {Promise<Array>} Array of class objects
   */
  async getClasses(filter = {}) {
    const cacheKey = `classes_${JSON.stringify(filter)}`;
    const cached = this._getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const queryParams = new URLSearchParams();
      if (filter.status) queryParams.append('status', filter.status);
      if (filter.provider) queryParams.append('provider', filter.provider);

      const url = queryParams.toString() 
        ? `${SERVER_URL}/api/classes?${queryParams}` 
        : `${SERVER_URL}/api/classes`;

      const response = await fetch(url);
      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch classes');
      }

      this._setCache(cacheKey, data.classes);
      return data.classes;
    } catch (error) {
      console.error('Error fetching classes:', error);
      throw error;
    }
  }

  /**
   * Get specific class information
   * @param {number} classId - The class ID
   * @returns {Promise<Object>} Class object with full details
   */
  async getClass(classId) {
    const cacheKey = `class_${classId}`;
    const cached = this._getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const response = await fetch(`${SERVER_URL}/api/classes/${classId}`);
      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || `Failed to fetch class ${classId}`);
      }

      this._setCache(cacheKey, data.class);
      return data.class;
    } catch (error) {
      console.error(`Error fetching class ${classId}:`, error);
      throw error;
    }
  }

  /**
   * Get available models for a specific class
   * @param {number} classId - The class ID
   * @returns {Promise<Object>} Object with models, modelsByProvider, and class info
   */
  async getAvailableModels(classId) {
    const cacheKey = `models_${classId}`;
    const cached = this._getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const response = await fetch(`${SERVER_URL}/api/classes/${classId}/models`);
      const data = await response.json();

      if (!data.success) {
        // Handle specific error cases
        if (data.status === 'EMPTY') {
          return {
            classId,
            className: `Class ${classId}`,
            status: 'EMPTY',
            models: [],
            modelsByProvider: {},
            limits: null,
            error: data.error
          };
        }
        throw new Error(data.error || `Failed to fetch models for class ${classId}`);
      }

      this._setCache(cacheKey, data);
      return data;
    } catch (error) {
      console.error(`Error fetching models for class ${classId}:`, error);
      throw error;
    }
  }

  /**
   * Validate a manifest against a class
   * @param {Object} manifest - The query manifest to validate
   * @param {number} classId - The class ID to validate against
   * @returns {Promise<Object>} Validation result
   */
  async validateManifest(manifest, classId) {
    try {
      const response = await fetch(`${SERVER_URL}/api/classes/${classId}/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ manifest }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Validation failed');
      }

      return data.validation;
    } catch (error) {
      console.error(`Error validating manifest against class ${classId}:`, error);
      throw error;
    }
  }

  /**
   * Check if a class ID is tracked (in curated range)
   * @param {number} classId - The class ID
   * @returns {boolean} True if tracked
   */
  isTracked(classId) {
    // Based on docs: tracked classes are < 2^56
    return classId < Math.pow(2, 56);
  }

  /**
   * Check if a class ID is reserved (experimental range)
   * @param {number} classId - The class ID  
   * @returns {boolean} True if reserved
   */
  isReserved(classId) {
    // Based on docs: reserved classes are >= 2^56
    return classId >= Math.pow(2, 56);
  }

  /**
   * Get active classes only
   * @returns {Promise<Array>} Array of active class objects
   */
  async getActiveClasses() {
    return this.getClasses({ status: 'ACTIVE' });
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get item from cache if not expired
   * @private
   */
  _getFromCache(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const { data, timestamp } = cached;
    if (Date.now() - timestamp > this.cacheTimeout) {
      this.cache.delete(key);
      return null;
    }

    return data;
  }

  /**
   * Set item in cache with timestamp
   * @private
   */
  _setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }
}

// Create singleton instance
export const classMapService = new ClassMapService();
export default classMapService;

