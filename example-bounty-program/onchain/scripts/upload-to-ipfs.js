#!/usr/bin/env node
// scripts/upload-to-ipfs.js
require('dotenv').config();
const axios = require('axios');

// Get text from command line argument or use default
const text = process.argv[2] || "This is a test file for oracle evaluation.";

async function uploadTextToPinata(textContent) {
  const PINATA_JWT = process.env.IPFS_PINNING_KEY;

  if (!PINATA_JWT) {
    throw new Error('Missing IPFS_PINNING_KEY in .env file');
  }

  const url = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
  
  const data = {
    pinataContent: {
      content: textContent
    },
    pinataMetadata: {
      name: `test-${Date.now()}.txt`
    }
  };

  try {
    const response = await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PINATA_JWT}`
      }
    });

    console.log('\n✅ Upload successful!');
    console.log('CID:', response.data.IpfsHash);
    console.log('Gateway URL:', `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`);
    
    return response.data.IpfsHash;
  } catch (error) {
    console.error('Upload failed:', error.response?.data || error.message);
    throw error;
  }
}

// Run
(async () => {
  console.log('Uploading text to IPFS via Pinata...');
  console.log('Text length:', text.length, 'characters');
  console.log('Text preview:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
  
  const cid = await uploadTextToPinata(text);
  
  console.log('\n📋 Use this CID in your test:');
  console.log(`const CIDS = ["${cid}"];`);
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

