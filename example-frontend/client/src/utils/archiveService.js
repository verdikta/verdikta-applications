import JSZip from 'jszip';

class ArchiveService {
  constructor() {
    this.testMode = process.env.REACT_APP_TEST_MODE === 'true';
    if (this.testMode) {
      console.info('ArchiveService initialized in TEST_MODE.');
    }
  }

  /**
   * Extracts files from a ZIP archive
   * @param {File} archiveFile - The ZIP file to process
   * @returns {Promise<Array>} - Array of extracted files
   */
  async extractArchive(archiveFile) {
    try {
      console.info(`Processing archive: ${archiveFile.name}`);
      
      const zip = new JSZip();
      const zipData = await zip.loadAsync(archiveFile);
      
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
   * Creates a ZIP archive from files
   * @param {Array<File>} files - Array of files to archive
   * @param {Object} manifest - Manifest object to include
   * @returns {Promise<Blob>} - The created ZIP file
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
   * Validates the manifest structure
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

export default new ArchiveService(); 