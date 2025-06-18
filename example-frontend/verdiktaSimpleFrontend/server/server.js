const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const ipfsClient = require('./services/ipfsClient');
// Import contract routes and manager
const contractRoutes = require('./routes/contractRoutes');
const { syncOnShutdown } = require('./utils/contractsManager');

// Constants
const UPLOAD_TIMEOUT = 60000; // 60 seconds
const IPFS_FETCH_TIMEOUT = 45000; // 45 seconds base timeout
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 2000;
const INITIAL_PROPAGATION_DELAY = 3000; // Wait 3 seconds before first attempt
const CID_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58}|B[A-Z2-7]{58}|z[1-9A-HJ-NP-Za-km-z]{48}|F[0-9A-F]{50}$/i;

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  console.error('Server error:', err);
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
    console.log('Received file:', {
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
    console.log('Temporary directory initialized');
  } catch (error) {
    console.error('Error initializing tmp directory:', error);
    throw error;
  }
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Register contract routes
app.use('/api/contracts', contractRoutes);

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
    console.log('Processing upload:', {
      originalname: req.file.originalname,
      path: req.file.path,
      size: req.file.size
    });

    const cid = await ipfsClient.uploadToIPFS(req.file.path);
    console.log('Upload successful:', { cid });

    res.json({
      success: true,
      cid,
      filename: req.file.originalname
    });

  } catch (error) {
    console.error('Upload failed:', error);
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

  // Validate CID format
  if (!CID_REGEX.test(cid)) {
    console.error('Invalid CID format:', cid);
    return res.status(400).json({
      error: 'Invalid CID format',
      details: 'The provided CID does not match the expected format'
    });
  }

  let currentTry = 0;

  // Add initial delay for IPFS propagation
  await new Promise(resolve => setTimeout(resolve, INITIAL_PROPAGATION_DELAY));

  // Update the gateway list with more reliable options
  const IPFS_GATEWAYS = [
    'https://gateway.pinata.cloud',
    'https://ipfs.io',
    'https://dweb.link',
    'https://cf-ipfs.com',
    'https://gateway.ipfs.io'
  ];

  // Update the fetchWithTimeout function
  const fetchWithTimeout = async (attempt) => {
    const controller = new AbortController();
    let timeoutId;

    try {
      console.log(`Fetching from IPFS (attempt ${attempt + 1}/${MAX_RETRIES}):`, cid);
      
      const timeoutMs = IPFS_FETCH_TIMEOUT * (1 + attempt * 0.5);
      console.log(`Timeout set to ${timeoutMs}ms`);

      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          console.log(`Timeout reached after ${timeoutMs}ms for attempt ${attempt + 1}`);
          controller.abort();
          reject(new Error('Timeout'));
        }, timeoutMs);
      });

      // Use the ipfsClient service with the isQueryPackage flag when appropriate
      try {
        console.log(`Using ipfsClient with isQueryPackage=${isQueryPackage}`);
        const data = await ipfsClient.fetchFromIPFS(cid, { isQueryPackage });
        return { 
          data, 
          headers: new Map([['content-type', 'application/octet-stream']]),
          gateway: 'ipfsClient'
        };
      } catch (ipfsClientError) {
        console.log(`ipfsClient failed:`, ipfsClientError.message);
        // Fall back to gateway method if ipfsClient fails
      }

      // Try each gateway with DNS error handling
      for (const baseGateway of IPFS_GATEWAYS) {
        const gateway = `${baseGateway}/ipfs/${cid}`;
        try {
          console.log(`Trying gateway: ${gateway}`);
          
          // First check if gateway is responsive
          try {
            await fetch(`${baseGateway}/api/v0/version`, {
              timeout: 5000,
              headers: {
                'Accept': '*/*',
                'User-Agent': 'Verdikta-Server/1.0'
              }
            });
          } catch (pingError) {
            console.log(`Gateway ${baseGateway} is not responsive:`, pingError.message);
            continue;
          }

          // Gateway is responsive, try fetching the content
          const response = await Promise.race([
            fetch(gateway, {
              signal: controller.signal,
              headers: {
                'Accept': '*/*',
                'User-Agent': 'Verdikta-Server/1.0'
              }
            }),
            timeoutPromise
          ]);

          // Log response status for debugging
          console.log(`Gateway ${gateway} response status:`, response.status);

          if (response.ok) {
            const data = await response.buffer();
            return { data, headers: response.headers, gateway };
          } else if (response.status === 404) {
            throw new Error(`CID not found: ${cid}`);
          }
          
          console.log(`Gateway ${gateway} returned status: ${response.status}`);
        } catch (gatewayError) {
          if (gatewayError.name === 'AbortError') {
            throw gatewayError; // Propagate timeout errors
          }
          if (gatewayError.message.includes('CID not found')) {
            throw gatewayError; // Propagate 404 errors
          }
          console.log(`Gateway ${gateway} failed:`, gatewayError.message);
          continue;
        }
      }

      throw new Error('All IPFS gateways failed');

    } finally {
      clearTimeout(timeoutId);
    }
  };

  while (currentTry < MAX_RETRIES) {
    try {
      const { data, headers, gateway } = await fetchWithTimeout(currentTry);
      console.log(`Successfully fetched from gateway: ${gateway}`);

      res.set({
        'Content-Type': headers.get('content-type'),
        'Content-Length': headers.get('content-length'),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000',
        'X-IPFS-Gateway': gateway
      });

      res.send(data);
      return;

    } catch (error) {
      console.error(`Attempt ${currentTry + 1} failed:`, error);
      
      // If CID not found, return 404 immediately
      if (error.message.includes('CID not found')) {
        return res.status(404).json({
          error: 'CID not found',
          details: error.message
        });
      }
      
      if (currentTry === MAX_RETRIES - 1) {
        return res.status(error.name === 'AbortError' ? 504 : 500).json({
          error: 'Failed to fetch from IPFS',
          details: error.message,
          attempt: currentTry + 1
        });
      }

      // Exponential backoff with jitter
      const baseDelay = INITIAL_RETRY_DELAY * Math.pow(2, currentTry);
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;
      
      console.log(`Waiting ${Math.round(delay)}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      currentTry++;
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Initialize server
const startServer = async () => {
  try {
    await initializeTmpDirectory();

    const PORT = process.env.PORT || 5000;
    const HOST = process.env.HOST || '0.0.0.0';
    const server = app.listen(PORT, HOST, () => {
      console.log(`Server listening on ${HOST}:${PORT}`);
      console.log('Environment:', {
        NODE_ENV: process.env.NODE_ENV,
        IPFS_PINNING_SERVICE: process.env.IPFS_PINNING_SERVICE ? 'Set' : 'Not set',
        IPFS_PINNING_KEY: process.env.IPFS_PINNING_KEY ? 'Set' : 'Not set'
      });
    });

    // Handle server shutdown
    const shutdown = async () => {
      console.log('Shutting down server...');
      
      // Sync contracts to .env file before shutdown
      try {
        await syncOnShutdown();
        console.log('Contracts synced to .env file');
      } catch (error) {
        console.error('Failed to sync contracts to .env:', error);
      }
      
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });

      // Force close after 30 seconds
      setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

app.use(errorHandler);
startServer();

