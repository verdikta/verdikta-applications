// src/utils/packageUtils.js
import archiveService from './archiveService'; // or wherever you keep it

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
    type: f.file.type,
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

  // 4) Use your archiveService to create the ZIP
  // `archiveService.createArchive` is your custom code (or a library wrapper).
  // Typically, it returns a Blob or ArrayBuffer.
  console.log('Creating ZIP with manifest:', manifest);
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

  console.log('Fetching query package from:', url);
  const response = await fetch(url);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.details || `Failed to fetch query package. Status: ${response.status}`);
  }

  const blob = await response.blob();
  const archiveFile = new File([blob], 'query_package.zip', { type: 'application/zip' });

  // Extract the archive
  console.log('Extracting archive via archiveService...');
  const files = await archiveService.extractArchive(archiveFile);

  // Find manifest.json
  const manifestFile = files.find((f) => f.name === 'manifest.json');
  if (!manifestFile) {
    throw new Error('No manifest.json found in archive');
  }
  const manifest = JSON.parse(await manifestFile.text());

  // Find primary_query.json
  const primaryFile = files.find((f) => f.name === manifest.primary?.filename);
  if (!primaryFile) {
    throw new Error(`Primary file not found: ${manifest.primary?.filename}`);
  }
  const primaryData = JSON.parse(await primaryFile.text());

  return {
    query: primaryData.query || '',
    outcomes: primaryData.outcomes || [],
    numOutcomes: manifest.juryParameters?.NUMBER_OF_OUTCOMES || 2,
    iterations: manifest.juryParameters?.ITERATIONS || 1,
    juryNodes: manifest.juryParameters?.AI_NODES || [],
    additionalFiles: manifest.additional || [],
    supportFiles: manifest.support || []
  };
}