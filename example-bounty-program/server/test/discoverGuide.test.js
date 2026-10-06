/**
 * The verdikta-discover guide is a static client file (nginx serves any path with an extension from the build), and
 * /llms.txt points agents at it.
 */
jest.mock('../config', () => ({ config: { network: 'base-sepolia', networkName: 'Base Sepolia', chainId: 84532, bountyEscrowAddress: '0x' + '11'.repeat(20) } }));
jest.mock('../utils/jobStorage', () => ({ listJobs: jest.fn(async () => []) }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const clientIdentification = require('../middleware/clientIdentification');

const GUIDE = '/guides/verdikta-discover.txt';

describe('verdikta-discover guide', () => {
  const app = express();
  app.use(clientIdentification);
  app.use(require('../routes/agentRoutes'));

  test('/llms.txt links the guide under buyer discovery', async () => {
    const res = await request(app).get('/llms.txt');
    expect(res.status).toBe(200);
    const section = res.text.split('## Buyer discovery (no wallet)')[1].split('\n## ')[0];
    expect(section).toContain(GUIDE);
  });

  test('the linked file ships with the client build', () => {
    expect(fs.existsSync(path.join(__dirname, '../../client/public', GUIDE))).toBe(true);
  });
});
