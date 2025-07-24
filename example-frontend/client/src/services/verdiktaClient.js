// Browser-compatible wrapper for verdikta-common functionality
import JSZip from 'jszip';

/**
 * Browser-compatible ArchiveService using JSZip
 * Provides the same API as verdikta-common ArchiveService but works in browsers
 */
class ArchiveService {
  constructor() {
    this.testMode = process.env.REACT_APP_TEST_MODE === 'true';
    if (this.testMode) {
      console.info('ArchiveService initialized in TEST_MODE.');
    }
  }

  /**
   * Extract archive from buffer/blob data (compatible with verdikta-common API)
   * @param {Buffer|Blob|File} archiveData - The archive data
   * @param {string} extractionPath - Not used in browser version, kept for API compatibility
   * @returns {Promise<Array>} - Array of extracted files
   */
  async extractArchive(archiveData, extractionPath = null) {
    try {
      console.info('Processing archive with ArchiveService');
      
      const zip = new JSZip();
      const zipData = await zip.loadAsync(archiveData);
      
      const files = [];
      
      // Process each file in the archive
      for (const [filename, file] of Object.entries(zipData.files)) {
        if (!file.dir) {
          const content = await file.async('blob');
          files.push(new File([content], filename, {
            type: this.getFileType(filename)
          }));
        }
      }

      console.info(`Successfully extracted ${files.length} files`);
      return files;
    } catch (error) {
      console.error('Failed to extract archive:', error);
      throw new Error(`Failed to extract archive: ${error.message}`);
    }
  }

  /**
   * Create archive from files array (compatible with verdikta-common API)
   * @param {Array<File>} files - Array of files to archive
   * @param {Object} manifest - Manifest object to include
   * @returns {Promise<Blob>} - The created archive
   */
  async createArchive(files, manifest) {
    try {
      const zip = new JSZip();
      
      // Add manifest
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      
      // Add all other files
      for (const file of files) {
        zip.file(file.name, file);
      }
      
      // Generate ZIP file
      const content = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 6
        }
      });
      
      return content;
    } catch (error) {
      console.error('Failed to create archive:', error);
      throw new Error(`Failed to create archive: ${error.message}`);
    }
  }

  /**
   * Detect archive format (simplified for browser)
   * @param {Buffer|Blob} archiveData - The archive data
   * @returns {string} - Archive format
   */
  detectArchiveFormat(archiveData) {
    // In browser context, we primarily handle ZIP files
    return 'zip';
  }

  /**
   * Determines file type based on extension
   * @param {string} filename - Name of the file
   * @returns {string} - MIME type
   */
  getFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const mimeTypes = {
      'txt': 'text/plain',
      'json': 'application/json',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'csv': 'text/csv',
      'html': 'text/html',
      'mp3': 'audio/mpeg',
      'ogg': 'audio/ogg',
      'webm': 'video/webm'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}

/**
 * Browser-compatible ManifestParser
 * Provides basic manifest parsing functionality for browsers
 */
class ManifestParser {
  // Browser version doesn't need IPFS client or logger dependencies

  /**
   * Parse a manifest from extracted files
   * @param {Array<File>} extractedFiles - Array of extracted files
   * @returns {Promise<Object>} - Parsed manifest result
   */
  async parse(extractedFiles) {
    try {
      // Find manifest.json in the extracted files
      const manifestFile = extractedFiles.find(file => file.name === 'manifest.json');
      if (!manifestFile) {
        throw new Error('No manifest.json found in archive');
      }

      const manifestContent = await manifestFile.text();
      const manifest = JSON.parse(manifestContent);

      // Validate required fields
      if (!manifest.version || !manifest.primary) {
        throw new Error('Invalid manifest: missing required fields "version" or "primary"');
      }

      // Find primary file
      const primaryFile = extractedFiles.find(file => file.name === manifest.primary.filename);
      if (!primaryFile) {
        throw new Error('Primary file not found in archive');
      }

      const primaryContent = await primaryFile.text();
      const primaryData = JSON.parse(primaryContent);

      // Return structured result
      return {
        manifest,
        primaryData,
        extractedFiles,
        query: primaryData.query || '',
        outcomes: primaryData.outcomes || [],
        numOutcomes: manifest.juryParameters?.NUMBER_OF_OUTCOMES || 2,
        iterations: manifest.juryParameters?.ITERATIONS || 1,
        juryNodes: manifest.juryParameters?.AI_NODES || [],
        additionalFiles: manifest.additional || [],
        supportFiles: manifest.support || []
      };
    } catch (error) {
      throw new Error(`Invalid manifest file: ${error.message}`);
    }
  }

  /**
   * Validate manifest structure
   * @param {Object} manifest - The manifest object to validate
   * @returns {boolean} - Whether the manifest is valid
   */
  validateManifest(manifest) {
    try {
      // Check required fields
      if (!manifest.version || !manifest.primary) {
        throw new Error('Missing required fields: version or primary');
      }

      // Validate primary file reference
      if ((!manifest.primary.filename && !manifest.primary.hash) || 
          (manifest.primary.filename && manifest.primary.hash)) {
        throw new Error('Primary must have either filename or hash, but not both');
      }

      // Validate jury parameters if present
      if (manifest.juryParameters) {
        if (!manifest.juryParameters.NUMBER_OF_OUTCOMES || 
            !manifest.juryParameters.AI_NODES ||
            !manifest.juryParameters.ITERATIONS) {
          throw new Error('Invalid jury parameters');
        }

        // Validate AI nodes
        const totalWeight = manifest.juryParameters.AI_NODES.reduce(
          (sum, node) => sum + node.WEIGHT, 
          0
        );
        if (Math.abs(totalWeight - 1.0) > 0.0001) {
          throw new Error('AI node weights must sum to 1.0');
        }
      }

      return true;
    } catch (error) {
      console.error('Manifest validation failed:', error);
      throw error;
    }
  }
}

/**
 * Simple browser logger that mimics winston interface
 */
class Logger {
  constructor(config = {}) {
    this.level = config.level || 'info';
  }

  info(message, meta = {}) {
    console.info(message, meta);
  }

  debug(message, meta = {}) {
    if (this.level === 'debug') {
      console.debug(message, meta);
    }
  }

  warn(message, meta = {}) {
    console.warn(message, meta);
  }

  error(message, meta = {}) {
    console.error(message, meta);
  }

  setLevel(level) {
    this.level = level;
  }
}

/**
 * Browser-compatible client factory
 * Provides similar API to verdikta-common createClient but for browsers
 */
export function createClient(config = {}) {
  const logger = new Logger(config.logging || {});
  const archiveService = new ArchiveService();
  const manifestParser = new ManifestParser();

  return {
    logger,
    archiveService,
    manifestParser,
    // Note: No ipfsClient in browser version - use server API instead
  };
}

export { ArchiveService, ManifestParser, Logger };
export default createClient; 