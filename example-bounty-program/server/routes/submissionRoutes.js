const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { isValidFileType, isValidFileSize, MAX_FILE_SIZE } = require('../utils/validation');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../tmp'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (isValidFileType(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype} for file ${file.originalname}. Allowed: code files (.py, .sol, .cpp, .js, etc.), documents (.txt, .md, .pdf, .docx), images (.jpg, .png), and data files (.json, .xml, .yaml, .csv)`));
    }
  },
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  }
}).single('file');

/**
 * POST /api/bounties/:bountyId/submit
 * Upload deliverable to IPFS for submission
 */
router.post('/bounties/:bountyId/submit', async (req, res) => {
  let uploadedFile = null;

  try {
    // Handle file upload
    await new Promise((resolve, reject) => {
      upload(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded',
        details: 'Request must include a file in multipart/form-data format'
      });
    }

    uploadedFile = req.file;
    const { bountyId } = req.params;

    // Validate bountyId is a number
    const bountyIdNum = parseInt(bountyId, 10);
    if (isNaN(bountyIdNum)) {
      return res.status(400).json({
        error: 'Invalid bounty ID',
        details: 'Bounty ID must be a number'
      });
    }

    logger.info(`POST /api/bounties/${bountyId}/submit called`, {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });

    // Validate file size
    if (!isValidFileSize(req.file.size)) {
      return res.status(400).json({
        error: 'File too large',
        details: `File size must be <= ${MAX_FILE_SIZE / 1024 / 1024} MB`
      });
    }

    // Upload to IPFS
    const ipfsClient = req.app.locals.ipfsClient;
    const deliverableCid = await ipfsClient.uploadToIPFS(req.file.path);

    logger.info('Deliverable uploaded to IPFS successfully', {
      bountyId,
      cid: deliverableCid,
      filename: req.file.originalname,
      size: req.file.size
    });

    res.json({
      success: true,
      deliverableCid,
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      message: 'File uploaded to IPFS. Call submitAndEvaluate() with this CID.'
    });

  } catch (error) {
    logger.error('Error uploading deliverable:', error);
    
    // Check for specific error types
    if (error.message.includes('Invalid file type')) {
      return res.status(400).json({
        error: 'Invalid file type',
        details: error.message
      });
    }

    res.status(500).json({
      error: 'Failed to upload deliverable',
      details: error.message
    });
  } finally {
    // Clean up uploaded file
    if (uploadedFile?.path) {
      await fs.unlink(uploadedFile.path).catch(err => 
        logger.warn('Failed to clean up temp file:', err)
      );
    }
  }
});

module.exports = router;

