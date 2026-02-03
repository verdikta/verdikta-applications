const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fetch = require('node-fetch');
require('dotenv').config();

const { IPFSClient, classMap } = require('@verdikta/common');
const appLogger = require('./utils/appLogger');
const app = express();

// Initialize IPFS client with sanitized logger
const ipfsClient = new IPFSClient({
  gateway: 'https://ipfs.io',
  pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
  pinningKey: process.env.IPFS_PINNING_KEY,
  timeout: 30000,
  retryOptions: { retries: 5, factor: 2 }
}, appLogger);
const logger = appLogger;
// Import contract routes and manager
const contractRoutes = require('./routes/contractRoutes');
const { syncOnShutdown } = require('./utils/contractsManager');

// Import admin routes
const adminRoutes = require('./routes/adminRoutes');

// Constants
const UPLOAD_TIMEOUT = 60000; // 60 seconds
const IPFS_FETCH_TIMEOUT = 45000; // 45 seconds base timeout
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 2000;
const INITIAL_PROPAGATION_DELAY = 3000; // Wait 3 seconds before first attempt
const CID_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58}|B[A-Z2-7]{58}|z[1-9A-HJ-NP-Za-km-z]{48}|F[0-9A-F]{50}$/i;

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  logger.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
  });
};

// Configure multer with error handling
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'tmp'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    logger.debug('Received file:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });

    if (file.mimetype === 'application/zip' || 
        file.mimetype === 'application/x-zip-compressed' ||
        (file.mimetype === 'application/octet-stream' && file.originalname.endsWith('.zip'))) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Expected ZIP, received: ${file.mimetype}`));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1
  }
}).single('file');

// Ensure tmp directory exists and is clean
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

// Register contract routes
app.use('/api/contracts', contractRoutes);

// Register admin routes
app.use('/api/admins', adminRoutes);

// ClassMap API endpoints
// Get all available classes
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

// Get models for a specific class
app.get('/api/classes/:classId/models', (req, res) => {
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
    
    if (classInfo.status !== 'ACTIVE') {
      return res.status(400).json({
        error: 'Class not active',
        details: `Class ID ${classId} has status: ${classInfo.status}`,
        status: classInfo.status
      });
    }
    
    // Group models by provider for easier frontend consumption
    const modelsByProvider = {};
    classInfo.models.forEach(model => {
      if (!modelsByProvider[model.provider]) {
        modelsByProvider[model.provider] = [];
      }
      modelsByProvider[model.provider].push({
        model: model.model,
        contextWindow: model.context_window_tokens,
        supportedFileTypes: model.supported_file_types
      });
    });
    
    res.json({
      success: true,
      classId: Number(classInfo.id),
      className: classInfo.name,
      status: classInfo.status,
      models: classInfo.models,
      modelsByProvider,
      limits: classInfo.limits
    });
  } catch (error) {
    logger.error('Error fetching models for class:', error);
    res.status(500).json({
      error: 'Failed to fetch models',
      details: error.message
    });
  }
});

// Validate manifest against class
app.post('/api/classes/:classId/validate', (req, res) => {
  try {
    const classId = parseInt(req.params.classId, 10);
    const { manifest } = req.body;
    
    if (isNaN(classId)) {
      return res.status(400).json({
        error: 'Invalid class ID',
        details: 'Class ID must be a number'
      });
    }
    
    if (!manifest) {
      return res.status(400).json({
        error: 'Missing manifest',
        details: 'Request body must include manifest object'
      });
    }
    
    const result = classMap.validateQueryAgainstClass(manifest, classId);
    
    // Convert any BigInt values for JSON serialization
    const serializedResult = {
      ...result,
      classId: Number(classId)
    };
    
    res.json({
      success: true,
      validation: serializedResult
    });
  } catch (error) {
    logger.error('Error validating manifest:', error);
    res.status(500).json({
      error: 'Failed to validate manifest',
      details: error.message
    });
  }
});

// File upload endpoint with timeout
app.post('/api/upload', async (req, res) => {
  let uploadedFile = null;

  try {
    // Wrap multer in a promise with timeout
    await Promise.race([
      new Promise((resolve, reject) => {
        upload(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Upload timeout')), UPLOAD_TIMEOUT)
      )
    ]);

    if (!req.file) {
      throw new Error('No file uploaded');
    }

    uploadedFile = req.file;
    logger.info('Processing upload:', {
      originalname: req.file.originalname,
      path: req.file.path,
      size: req.file.size
    });

    // Upload to IPFS using verdikta-common (expects a file path)
    const cid = await ipfsClient.uploadToIPFS(req.file.path);
    logger.info('Upload successful:', { cid, filename: req.file.originalname });

    res.json({
      success: true,
      cid,
      filename: req.file.originalname
    });

  } catch (error) {
    logger.error('Upload failed:', error);
    res.status(error.message === 'Upload timeout' ? 408 : 500).json({
      error: 'Upload failed',
      details: error.message
    });
  } finally {
    // Clean up uploaded file
    if (uploadedFile?.path) {
      await fs.unlink(uploadedFile.path).catch(console.error);
    }
  }
});

// IPFS fetch endpoint with improved retry logic
app.get('/api/fetch/:cid', async (req, res) => {
  const { cid } = req.params;
  const isQueryPackage = req.query.isQueryPackage === 'true';
  const isMultiCID = cid.includes(',');

  // For multi-CID requests, validate each CID separately
  if (isMultiCID) {
    const cidArray = cid.split(',').map(c => c.trim()).filter(c => c);
    for (const singleCID of cidArray) {
      if (!CID_REGEX.test(singleCID)) {
        logger.error('Invalid CID format in multi-CID request:', singleCID);
        return res.status(400).json({
          error: 'Invalid CID format',
          details: `Invalid CID in multi-CID request: ${singleCID}`
        });
      }
    }
  } else {
    // Validate single CID format
    if (!CID_REGEX.test(cid)) {
      logger.error('Invalid CID format:', cid);
      return res.status(400).json({
        error: 'Invalid CID format',
        details: 'The provided CID does not match the expected format'
      });
    }
  }

  try {
    logger.info('Fetching from IPFS:', { cid, isQueryPackage, isMultiCID });
    
    // Handle multi-CID requests
    if (isMultiCID) {
      const cidArray = cid.split(',').map(c => c.trim()).filter(c => c);
      logger.info('Processing multi-CID request:', cidArray);
      
      // Fetch the first CID (primary result)
      const primaryCID = cidArray[0];
      logger.info('Fetching primary CID from multi-CID request:', primaryCID);
      const data = await ipfsClient.fetchFromIPFS(primaryCID);
      
      logger.info('Successfully fetched primary CID from multi-CID request:', { cid: primaryCID, size: data.length });

      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000',
        'X-Multi-CID': 'true',
        'X-Primary-CID': primaryCID,
        'X-All-CIDs': cid
      });

      return res.send(data);
    }
    
    // Process CID for query packages if needed (extract first CID for single-CID strings)
    let cidToFetch = cid.trim();
    if (isQueryPackage && cidToFetch.includes(',')) {
      cidToFetch = cidToFetch.split(',')[0].trim();
      logger.info('Processing query package CID - using first CID only:', cidToFetch);
    }
    
    // Use verdikta-common IPFSClient which handles retry logic and multiple gateways
    const data = await ipfsClient.fetchFromIPFS(cidToFetch);
    
    logger.info('Successfully fetched from IPFS:', { cid: cidToFetch, size: data.length });

    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000'
    });

    res.send(data);

  } catch (error) {
    logger.error('Failed to fetch from IPFS:', { cid, error: error.message });
    
    // Check for specific error types
    if (error.message.includes('not found') || error.message.includes('404')) {
      return res.status(404).json({
        error: 'CID not found',
        details: error.message
      });
    }
    
    if (error.message.includes('timeout') || error.message.includes('timed out')) {
      return res.status(504).json({
        error: 'Request timeout',
        details: error.message
      });
    }
    
    return res.status(500).json({
      error: 'Failed to fetch from IPFS',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Timeout logging endpoint
app.post('/api/log-timeout', (req, res) => {
  try {
    const { message, timestamp, walletAddress } = req.body;
    logger.error('CLIENT TIMEOUT DETECTED', {
      message,
      timestamp,
      walletAddress,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('Error logging timeout:', error);
    res.status(500).json({ error: 'Failed to log timeout' });
  }
});

// Initialize server
const startServer = async () => {
  try {
    await initializeTmpDirectory();

    const PORT = process.env.PORT || 5000;
    const HOST = process.env.HOST || '0.0.0.0';
    const server = app.listen(PORT, HOST, () => {
      logger.info(`Server listening on ${HOST}:${PORT}`);
      logger.info('Environment:', {
        NODE_ENV: process.env.NODE_ENV,
        IPFS_PINNING_SERVICE: process.env.IPFS_PINNING_SERVICE ? 'Set' : 'Not set',
        IPFS_PINNING_KEY: process.env.IPFS_PINNING_KEY ? 'Set' : 'Not set'
      });
    });

    // Handle server shutdown
    const shutdown = async () => {
      logger.info('Shutting down server...');
      
      // Sync contracts to .env file before shutdown
      try {
        await syncOnShutdown();
        logger.info('Contracts synced to .env file');
      } catch (error) {
        logger.error('Failed to sync contracts to .env:', error);
      }
      
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

app.use(errorHandler);
startServer();

