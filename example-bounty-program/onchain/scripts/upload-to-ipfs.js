#!/usr/bin/env node
// scripts/upload-to-ipfs.js
require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const text = process.argv[2] || "This is a test file for oracle evaluation.";

async function uploadFileToPinata(textContent) {
  const PINATA_JWT = process.env.IPFS_PINNING_KEY;

  if (!PINATA_JWT) {
    throw new Error('Missing IPFS_PINNING_KEY in .env');
  }

  // Create temporary file
  const filename = `test-${Date.now()}.txt`;
  fs.writeFileSync(filename, textContent);

  const url = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
  const data = new FormData();
  data.append('file', fs.createReadStream(filename));

  try {
    const response = await axios.post(url, data, {
      maxBodyLength: Infinity,
      headers: {
        ...data.getHeaders(),
        'Authorization': `Bearer ${PINATA_JWT}`
      }
    });

    // Clean up temp file
    fs.unlinkSync(filename);

    console.log('\n✅ Upload successful!');
    console.log('CID:', response.data.IpfsHash);
    console.log('Gateway URL:', `https://gateway.pinata.cloud/ipfs/${response.data.IpfsHash}`);
    
    return response.data.IpfsHash;
  } catch (error) {
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    console.error('Upload failed:', error.response?.data || error.message);
    throw error;
  }
}

(async () => {
  console.log('Uploading text file to IPFS via Pinata...');
  console.log('Text length:', text.length, 'characters');
  console.log('Text preview:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));
  
  const cid = await uploadFileToPinata(text);
  
  console.log('\n📋 Use this CID in your test:');
  console.log(`const CIDS = ["${cid}"];`);
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

