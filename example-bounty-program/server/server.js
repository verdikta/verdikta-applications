const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config();

const { IPFSClient, classMap } = require('@verdikta/common');
const logger = require('./utils/logger');
const bountyRoutes = require('./routes/bountyRoutes');
const submissionRoutes = require('./routes/submissionRoutes');
const ipfsRoutes = require('./routes/ipfsRoutes');

const app = express();

// Initialize IPFS client
const ipfsClient = new IPFSClient({
  gateway: process.env.IPFS_GATEWAY || 'https://ipfs.io',
  pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
  pinningKey: process.env.IPFS_PINNING_KEY,
  timeout: 30000,
  retryOptions: { retries: 5, factor: 2 }
}, logger);

// Make ipfsClient available to routes
app.locals.ipfsClient = ipfsClient;

// Constants
const UPLOAD_TIMEOUT = 60000; // 60 seconds
const CID_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58}|B[A-Z2-7]{58}|z[1-9A-HJ-NP-Za-km-z]{48}|F[0-9A-F]{50}$/i;

// Ensure tmp directory exists
const initializeTmpDirectory = async () => {
  const tmpDir = path.join(__dirname, 'tmp');
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    // Clean any leftover files
    const files = await fs.readdir(tmpDir);
    await Promise.all(
      files.map(file => fs.unlink(path.join(tmpDir, file)).catch(console.error))
    );
    logger.info('Temporary directory initialized');
  } catch (error) {
    logger.error('Error initializing tmp directory:', error);
    throw error;
  }
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// Routes
app.use('/api/bounties', bountyRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api', ipfsRoutes);

// ClassMap API endpoints (reused from example-frontend)
app.get('/api/classes', (req, res) => {
  try {
    const { status, provider } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (provider) filter.provider = provider;
    
    const classes = classMap.listClasses(filter);
    
    // Convert BigInt IDs to regular numbers for JSON serialization
    const serializedClasses = classes.map(cls => ({
      ...cls,
      id: Number(cls.id)
    }));
    
    res.json({
      success: true,
      classes: serializedClasses
    });
  } catch (error) {
    logger.error('Error fetching classes:', error);
    res.status(500).json({
      error: 'Failed to fetch classes',
      details: error.message
    });
  }
});

// Get specific class information
app.get('/api/classes/:classId', (req, res) => {
  try {
    const classId = parseInt(req.params.classId, 10);
    
    if (isNaN(classId)) {
      return res.status(400).json({
        error: 'Invalid class ID',
        details: 'Class ID must be a number'
      });
    }
    
    const classInfo = classMap.getClass(classId);
    
    if (!classInfo) {
      return res.status(404).json({
        error: 'Class not found',
        details: `Class ID ${classId} is not tracked`
      });
    }
    
    // Convert BigInt ID to regular number for JSON serialization
    const serializedClass = {
      ...classInfo,
      id: Number(classInfo.id)
    };
    
    res.json({
      success: true,
      class: serializedClass
    });
  } catch (error) {
    logger.error('Error fetching class:', error);
    res.status(500).json({
      error: 'Failed to fetch class',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: require('./package.json').version
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});

// Initialize server
const startServer = async () => {
  try {
    await initializeTmpDirectory();

    const PORT = process.env.PORT || 5000;
    const HOST = process.env.HOST || '0.0.0.0';
    const server = app.listen(PORT, HOST, () => {
      logger.info(`🚀 Bounty API server listening on ${HOST}:${PORT}`);
      logger.info('Environment:', {
        NODE_ENV: process.env.NODE_ENV,
        IPFS_PINNING_SERVICE: process.env.IPFS_PINNING_SERVICE ? 'Set' : 'Not set',
        IPFS_PINNING_KEY: process.env.IPFS_PINNING_KEY ? 'Set' : 'Not set',
        BOUNTY_ESCROW_ADDRESS: process.env.BOUNTY_ESCROW_ADDRESS
      });
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down server...');
      
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });

      // Force close after 30 seconds
      setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app; // For testing

