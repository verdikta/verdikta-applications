const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const logger = require('./utils/logger');
const statusRoutes = require('./routes/statusRoutes');

process.on('uncaughtException', (err) => {
  logger.error('[fatal] uncaughtException', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('[fatal] unhandledRejection', { reason: String(reason) });
});

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 5008;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'example-arbiters', uptime: process.uptime() });
});

app.use('/api', statusRoutes);

app.use((err, _req, res, _next) => {
  logger.error('[express] unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`example-arbiters server listening on port ${PORT}`);
});
