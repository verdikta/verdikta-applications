/**
 * Authoritative rubric-pointer derivation.
 *
 * The on-chain `evaluationCid` package is content-addressed/immutable and is
 * exactly what the oracle grades against; its manifest.additional entry named
 * `gradingRubric` carries the authoritative rubric hash. The loose top-level
 * `job.rubricCid` field is only a convenience cache: the chain-sync service
 * never writes it (so bounties created directly on-chain arrive with it
 * empty), and heals/renumbers have historically let it drift (see
 * scripts/healRubricCid.js and the bounty-247 postmortem in its header).
 *
 * This helper is the shared read-side primitive for re-deriving the pointer
 * from the package. It intentionally NEVER throws: a null return means "the
 * package gave nothing" (no/invalid archive, no manifest, no gradingRubric
 * reference, or an IPFS fetch failure) and callers fall back to whatever
 * behavior they had before deriving.
 */

const AdmZip = require('adm-zip');
const logger = require('./logger');

/**
 * Derive the gradingRubric hash referenced inside an evaluationCid package.
 *
 * @param {{ fetchFromIPFS(cid: string): Promise<Buffer> }} ipfsClient
 * @param {string} evaluationCid  the job's on-chain evaluation package CID
 * @returns {Promise<string|null>} the rubric CID, or null if underivable
 */
async function packageRubricHash(ipfsClient, evaluationCid) {
  if (!ipfsClient || !evaluationCid) return null;
  try {
    const archiveBuffer = await ipfsClient.fetchFromIPFS(evaluationCid);
    const zip = new AdmZip(archiveBuffer);
    const entries = zip.getEntries();
    const manifestEntry = entries.find(
      (e) => e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json')
    );
    if (!manifestEntry) return null;
    const manifest = JSON.parse(zip.readAsText(manifestEntry));
    const gradingRubricRef = manifest.additional?.find((a) => a.name === 'gradingRubric');
    return gradingRubricRef?.hash || null;
  } catch (err) {
    logger.warn('[rubricSource] failed to derive rubric hash from evaluationCid package', {
      evaluationCid,
      msg: err.message,
    });
    return null;
  }
}

module.exports = { packageRubricHash };
