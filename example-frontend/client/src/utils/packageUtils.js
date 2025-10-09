// src/utils/packageUtils.js
import { createClient } from '../services/verdiktaClient';
import { getFileMimeType } from './mimeTypeUtils';

// Initialize browser-compatible verdikta client
const { archiveService, manifestParser, logger } = createClient({
  logging: { level: 'info' }
});

/**
 * Creates a ZIP package (Blob or File) from:
 * 1) `primary_query.json`
 * 2) Supporting files (uploaded in the UI)
 * 3) IPFS references (CIDs)
 * 4) A `manifest.json` describing everything
 *
 * Then you can upload that ZIP to your Node server via /api/upload.
 */
export async function createQueryPackageArchive(
  queryFileContent,
  supportingFiles,
  ipfsCids,
  manifest
) {
  // 1) Build the primary query file
  const primaryFile = new File(
    [JSON.stringify(queryFileContent, null, 2)],
    'primary_query.json',
    { type: 'application/json' }
  );

  // 2) Update manifest with references
  const additionalFiles = supportingFiles.map((f, i) => ({
    name: `supportingFile${i + 1}`,
    type: getFileMimeType(f.file),
    filename: f.file.name,
    description: f.description || ''
  }));
  const cidFiles = ipfsCids.map((c, i) => ({
    name: c.name,
    type: 'ipfs/cid',
    hash: c.cid,
    description: c.description || ''
  }));

  manifest.additional = [...additionalFiles, ...cidFiles];

  // 3) Pass an array of real local File objects to the archive
  const allPhysicalFiles = [
    primaryFile,
    ...supportingFiles.map((f) => f.file)
  ];

  // 4) Use verdikta archiveService to create the ZIP
  // `archiveService.createArchive` creates a ZIP blob with manifest
  logger.info('Creating ZIP with manifest:', manifest);
  const archiveBlob = await archiveService.createArchive(allPhysicalFiles, manifest);
  // If you need a File instead of a Blob, you can do:
  //   return new File([archiveBlob], 'query_package.zip', { type: 'application/zip' });
  return archiveBlob;
}

/**
 * Fetches a query package (ZIP) from /api/fetch/:cid on your server,
 * unzips it, reads `manifest.json` + `primary_query.json`,
 * and returns an object with { query, numOutcomes, iterations, juryNodes, ... }.
 */
export async function fetchQueryPackageDetails(cid) {
  // In your original code, you used: fetch(`${SERVER_URL}/api/fetch/${cid}`)
  // We'll do the same here:
  const serverUrl = process.env.REACT_APP_SERVER_URL || 'http://localhost:5000';
  const url = `${serverUrl}/api/fetch/${cid.trim()}`;

  logger.info('Fetching query package from:', url);
  const response = await fetch(url);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.details || `Failed to fetch query package. Status: ${response.status}`);
  }

  const blob = await response.blob();

  // Extract the archive using verdikta client
  logger.info('Extracting archive via archiveService...');
  const files = await archiveService.extractArchive(blob);

  // Use manifestParser to parse the extracted content
  const result = await manifestParser.parse(files);
  logger.info('Parsed query package successfully');

  return result;
}