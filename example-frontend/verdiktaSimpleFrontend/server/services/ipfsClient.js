const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const fetch = require('node-fetch');

class IPFSClient {
  constructor() {
    // Public gateway for fetching
    this.gateway = 'https://ipfs.io';
    // Pinata service for uploading
    this.pinningService = config.ipfs.pinningService.replace(/\/$/, '');
    this.pinningKey = config.ipfs.pinningKey;
    this.timeout = 30000;
    this.controllers = new Set();
    
    console.log('IPFSClient initialized with:', {
      gateway: this.gateway,
      pinningService: this.pinningService,
      pinningKeyExists: !!this.pinningKey,
      pinningKeyLength: this.pinningKey ? this.pinningKey.length : 0
    });
  }

  async fetchFromIPFS(cid, options = {}) {
    // Default behavior for results: don't split CIDs
    let cidToFetch = cid.trim();
    
    // If this is a query package request and not a result, extract only the first CID
    // The frontend should pass isQueryPackage: true when fetching query packages
    if (options.isQueryPackage && cidToFetch.includes(',')) {
      cidToFetch = cidToFetch.split(',')[0].trim();
      console.log('Processing query package CID - using first CID only:', cidToFetch);
    }
    
    const url = `${this.gateway}/ipfs/${cidToFetch}`;
    
    console.log('Fetching from IPFS:', { 
        url,
        originalCid: cid.trim(),
        cidToFetch,
        isQueryPackage: !!options.isQueryPackage,
        gateway: this.gateway
    });

    const controller = new AbortController();
    this.controllers.add(controller);
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
        const response = await fetch(url, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        this.controllers.delete(controller);

        console.log('IPFS fetch response:', {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            url: response.url
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer);
    } catch (error) {
        clearTimeout(timeoutId);
        this.controllers.delete(controller);
        if (error.name === 'AbortError') {
            throw new Error('Failed to fetch from IPFS: Request timed out');
        }
        throw new Error(`Failed to fetch from IPFS: ${error.message}`);
    }
  }

  async uploadToIPFS(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    try {
        const form = new FormData();
        const fileStream = fs.createReadStream(filePath);
        
        // Debug file stream
        console.log('File stream details:', {
            path: filePath,
            exists: fs.existsSync(filePath),
            stats: fs.statSync(filePath),
            streamReadable: fileStream.readable
        });

        // Add file to form
        form.append('file', fileStream);

        const controller = new AbortController();
        this.controllers.add(controller);
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        // Get form headers
        const formHeaders = form.getHeaders();
        
        console.log('Request details:', {
            url: `${this.pinningService}/pinning/pinFileToIPFS`,
            method: 'POST',
            headers: {
                ...formHeaders,
                'Authorization': '[REDACTED]'
            }
        });

        // Use node-fetch with proper stream handling
        const response = await fetch(`${this.pinningService}/pinning/pinFileToIPFS`, {
            method: 'POST',
            body: form,
            headers: {
                ...formHeaders,
                'Authorization': `Bearer ${this.pinningKey}`
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        this.controllers.delete(controller);

        if (!response.ok) {
            const errorBody = await response.text();
            console.error('Upload error details:', {
                status: response.status,
                statusText: response.statusText,
                body: errorBody
            });
            throw new Error(`Upload failed with status: ${response.status}`);
        }

        const data = await response.json();
        return data.IpfsHash;
    } catch (error) {
        console.error('Upload error:', {
            name: error.name,
            message: error.message,
            stack: error.stack
        });
        
        if (error.name === 'AbortError') {
            throw new Error('Failed to upload to IPFS: Request timed out');
        }
        throw new Error(`Failed to upload to IPFS: ${error.message}`);
    }
  }

  cleanup() {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

module.exports = new IPFSClient();

