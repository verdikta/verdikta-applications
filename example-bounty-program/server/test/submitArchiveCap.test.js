/**
 * sec6 e2e: POST /submit and /submit/bundle accepted up to 10 files of 20 MB, zipped and pinned as
 * one archive of up to ~200 MB, but every arbiter downloads at most 64 MiB of an archive
 * (@verdikta/common ipfs.maxBytes). Such a submission fails every honest arbiter's fetch: no commit,
 * never evaluated, and when another slot commits each honest juror loses the no-commit points (the
 * e2e run blocked four). A built archive over the arbiters' download cap is refused before pinning.
 */
const path = require('path');
const os = require('os');
const realFs = jest.requireActual('fs');
process.env.VERDIKTA_TMP_DIR = path.join(os.tmpdir(), 'verdikta-archive-cap-test');
realFs.mkdirSync(process.env.VERDIKTA_TMP_DIR, { recursive: true });

jest.mock('../config', () => ({ config: { network: 'base-sepolia', bountyEscrowAddress: '0x' + 'ab'.repeat(20), chainId: 84532, explorer: 'https://sepolia.basescan.org',
  submissionDefaults: { maxOracleFeeWei: '20000000000000', alpha: 500, estimatedBaseCostWei: '10000000000000', maxFeeBasedScaling: 3 } } }));
jest.mock('../utils/contractService', () => ({ getContractService: () => ({ provider: {}, contract: {} }) }));
const NOW = Math.floor(Date.now() / 1000);
jest.mock('../utils/jobStorage', () => ({
  getJob: jest.fn(async (id) => ({ jobId: Number(id), onChain: true, status: 'OPEN', submissionOpenTime: 0, submissionCloseTime: Math.floor(Date.now() / 1000) + 86400,
    evaluationCid: 'Qm' + 'e'.repeat(44), classId: 128, submissions: [] })),
  readStorage: jest.fn(async () => ({ jobs: [] })), updateJob: jest.fn(async (_i, u) => u), listJobs: jest.fn(async () => []),
}));
let mockArchiveBytes = 0;
jest.mock('../utils/archiveGenerator', () => ({
  ...jest.requireActual('../utils/archiveGenerator'),
  createHunterSubmissionCIDArchive: jest.fn(async () => {
    const p = require('path').join(process.env.VERDIKTA_TMP_DIR, `built-${process.hrtime.bigint()}.zip`);
    const fd = jest.requireActual('fs').openSync(p, 'w'); jest.requireActual('fs').ftruncateSync(fd, mockArchiveBytes); jest.requireActual('fs').closeSync(fd); // sparse
    return { archivePath: p };
  }),
}));

const express = require('express');
const request = require('supertest');
const { MAX_ARCHIVE_BYTES } = require('../utils/archiveShapeValidator');

const HUNTER = '0x' + '11'.repeat(20);
const upload = jest.fn(async () => 'Qm' + 'h'.repeat(44));
function app() { const a = express(); a.use(express.json()); a.use('/jobs', require('../routes/jobRoutes')); a.locals.ipfsClient = { uploadToIPFS: upload }; return a; }

beforeEach(() => upload.mockClear());

describe.each(['/jobs/1/submit', '/jobs/1/submit/bundle'])('POST %s: archives over the arbiters\' download cap', (url) => {
  it('an archive one byte over the cap is refused before pinning', async () => {
    mockArchiveBytes = MAX_ARCHIVE_BYTES + 1;
    const res = await request(app()).post(url).field('hunter', HUNTER).field('hunterAddress', HUNTER).attach('files', Buffer.from('a haiku about rivers'), 'haiku.txt');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.details).toMatch(/arbiters download at most 67108864 bytes/);
    expect(upload).not.toHaveBeenCalled();
    expect(realFs.readdirSync(process.env.VERDIKTA_TMP_DIR).filter((f) => f.startsWith('built-'))).toEqual([]);
  });
  it('an archive at the cap is pinned', async () => {
    mockArchiveBytes = MAX_ARCHIVE_BYTES;
    const res = await request(app()).post(url).field('hunter', HUNTER).field('hunterAddress', HUNTER).attach('files', Buffer.from('a haiku about rivers'), 'haiku.txt');
    expect(res.status).not.toBe(413);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
