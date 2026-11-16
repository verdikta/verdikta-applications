// A pin target and a gateway on one loopback port, standing in for a kubo daemon (POST /api/v0/add,
// the call the tool makes) and an IPFS gateway (GET /ipfs/<cid>). Content addressed for one block, as
// kubo with raw leaves is. Every upload is recorded, in order, with the time on `clock` if given.
// Faults a test sets on `faults`: the service lies about the CID, stores other bytes, the gateway
// serves other bytes or is down, a non-raw CID, an answer that echoes the request's credential.
import crypto from 'node:crypto';
import http from 'node:http';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function rawCidOf(bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

/** A CID in the dag-pb form a multi-block file gets: nothing here can recompute it from the bytes. */
export function treeCidOf(bytes) {
  const digest = crypto.createHash('sha256').update('tree').update(bytes).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x70, 0x12, 0x20]), digest]))}`;
}

function fileOf(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType ?? '')?.[1];
  if (!boundary) return null;
  const head = Buffer.from(`--${boundary}`);
  const start = body.indexOf(head);
  const headerEnd = body.indexOf('\r\n\r\n', start);
  const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd);
  return body.subarray(headerEnd + 4, end);
}

export async function startIpfs() {
  const store = new Map();
  const uploads = [];
  const reads = [];
  const headers = [];
  const faults = {
    lieCid: false, // answers the CID of other bytes
    storeOther: false, // keeps other bytes under the true CID
    serveOther: false, // the gateway answers other bytes for every CID
    gatewayDown: false,
    pinDown: false,
    treeCid: false, // answers a multi-block style CID, for any bytes
    echo: false, // error answers quote the request's headers
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/v0/add') {
        headers.push({ ...req.headers });
        if (faults.pinDown) {
          res.statusCode = 503;
          res.end(faults.echo ? `refused: ${JSON.stringify(req.headers)}` : 'down');
          return;
        }
        const bytes = Buffer.from(fileOf(body, req.headers['content-type']));
        uploads.push({ bytes, at: Date.now() });
        const cid = faults.treeCid ? treeCidOf(bytes) : rawCidOf(faults.lieCid ? Buffer.concat([bytes, Buffer.from('x')]) : bytes);
        store.set(cid, faults.storeOther ? Buffer.concat([bytes, Buffer.from('other')]) : bytes);
        res.setHeader('content-type', 'application/json');
        res.end(`${JSON.stringify({ Name: 'file', Hash: cid, Size: String(bytes.length) })}\n`);
        return;
      }
      const m = /^\/ipfs\/([0-9A-Za-z]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        reads.push(m[1]);
        if (faults.gatewayDown) {
          res.statusCode = 504;
          res.end('timed out');
          return;
        }
        const found = store.get(m[1]);
        if (!found) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.end(faults.serveOther ? Buffer.concat([found, Buffer.from('other')]) : found);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    store,
    uploads,
    reads,
    headers,
    faults,
    /** Puts bytes on the store as a listing's flow pinned them. */
    put(bytes) {
      const cid = rawCidOf(bytes);
      store.set(cid, Buffer.from(bytes));
      return cid;
    },
    drop: (cid) => store.delete(cid),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
