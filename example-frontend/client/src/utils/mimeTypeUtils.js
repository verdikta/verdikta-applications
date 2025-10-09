// src/utils/mimeTypeUtils.js

/**
 * Determines the MIME type for a file based on its extension.
 * This is more reliable than the browser's File API type property,
 * which can return empty strings for unrecognized file types.
 * 
 * @param {string} filename - The name of the file
 * @returns {string} - The MIME type for the file
 */
export function getMimeType(filename) {
  if (!filename) {
    return 'application/octet-stream';
  }

  const ext = filename.split('.').pop().toLowerCase();
  
  const mimeTypes = {
    // Text files
    'txt': 'text/plain',
    'md': 'text/markdown',
    'csv': 'text/csv',
    'html': 'text/html',
    'htm': 'text/html',
    'css': 'text/css',
    'xml': 'text/xml',
    
    // Code files - treat as text/plain for AI processing
    'sol': 'text/plain',      // Solidity
    'js': 'text/plain',       // JavaScript
    'jsx': 'text/plain',      // React JSX
    'ts': 'text/plain',       // TypeScript
    'tsx': 'text/plain',      // React TSX
    'py': 'text/plain',       // Python
    'java': 'text/plain',     // Java
    'c': 'text/plain',        // C
    'cpp': 'text/plain',      // C++
    'h': 'text/plain',        // C/C++ header
    'hpp': 'text/plain',      // C++ header
    'rs': 'text/plain',       // Rust
    'go': 'text/plain',       // Go
    'rb': 'text/plain',       // Ruby
    'php': 'text/plain',      // PHP
    'swift': 'text/plain',    // Swift
    'kt': 'text/plain',       // Kotlin
    'sh': 'text/plain',       // Shell script
    'bash': 'text/plain',     // Bash script
    
    // JSON
    'json': 'application/json',
    
    // Images
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'bmp': 'image/bmp',
    'ico': 'image/x-icon',
    
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    
    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    
    // Video
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'avi': 'video/x-msvideo',
    'mov': 'video/quicktime',
    'wmv': 'video/x-ms-wmv',
    
    // Archives
    'zip': 'application/zip',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
    'rar': 'application/vnd.rar',
    '7z': 'application/x-7z-compressed'
  };
  
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Gets the MIME type for a File object.
 * Falls back to extension-based detection if the browser doesn't recognize the type.
 * 
 * @param {File} file - The File object
 * @returns {string} - The MIME type for the file
 */
export function getFileMimeType(file) {
  // Try browser's type first, but fall back to extension-based detection if empty
  if (file.type && file.type.trim() !== '') {
    return file.type;
  }
  return getMimeType(file.name);
}

