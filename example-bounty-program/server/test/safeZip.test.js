/**
 * Security: archives named by on-chain CIDs are attacker-chosen. adm-zip's getData()
 * allocated a 1 GiB entry from a 1 MB zip and the process was OOM-killed; readEntry caps
 * both the declared size and the inflation, and readBodyCapped caps the download.
 */
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const { readEntry, readEntryText, readBodyCapped } = require('../utils/safeZip');

function zipWith(name, content) {
  const z = new AdmZip();
  z.addFile(name, content);
  return new AdmZip(z.toBuffer());
}

describe('readEntry', () => {
  it('reads a normal entry', () => {
    const zip = zipWith('manifest.json', Buffer.from(JSON.stringify({ name: 'ok' })));
    expect(JSON.parse(readEntryText(zip.getEntry('manifest.json')))).toEqual({ name: 'ok' });
  });

  it('refuses an entry that declares more than the cap, before allocating it', () => {
    const zip = zipWith('manifest.json', Buffer.alloc(4 * 1024 * 1024, 0x20));
    expect(() => readEntry(zip.getEntry('manifest.json'), 1024 * 1024)).toThrow(/declares/);
  });

  it('caps inflation even when the header lies about the size', () => {
    const zip = zipWith('manifest.json', Buffer.alloc(4 * 1024 * 1024, 0x20));
    const e = zip.getEntry('manifest.json');
    e.header.size = 10; // a forged central directory size
    expect(() => readEntry(e, 1024 * 1024)).toThrow(/inflates past/);
  });

  it('reads a stored (uncompressed) entry and caps it', () => {
    const z = new AdmZip();
    z.addFile('a.txt', Buffer.from('hello'));
    z.getEntry('a.txt').header.method = 0;
    const zip = new AdmZip(z.toBuffer());
    expect(readEntryText(zip.getEntry('a.txt'))).toBe('hello');
    expect(() => readEntry(zip.getEntry('a.txt'), 2)).toThrow();
  });
});

describe('readBodyCapped', () => {
  it('refuses a declared Content-Length over the cap', async () => {
    const res = new Response('x'.repeat(10), { headers: { 'content-length': '999999999' } });
    await expect(readBodyCapped(res, 100)).rejects.toThrow(/declares/);
  });
  it('refuses a streamed body over the cap', async () => {
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(100)); c.close(); } });
    await expect(readBodyCapped(new Response(stream), 1000)).rejects.toThrow(/exceeds 1000/);
  });
  it('returns a body under the cap', async () => {
    expect((await readBodyCapped(new Response('abc'), 100)).toString()).toBe('abc');
  });
});
void zlib;

describe('the sync reads an attacker evaluation package through the caps', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; delete process.env.ZIP_ENTRY_MAX_BYTES; });
  it('an oversized manifest is skipped, not inflated (cap lowered to 1 MiB to keep the test fast)', async () => {
    const z = new AdmZip();
    z.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'Planted', pad: ' '.repeat(16 * 1024 * 1024) })));
    const bomb = z.toBuffer();
    global.fetch = async () => new Response(bomb, { status: 200 });
    process.env.ZIP_ENTRY_MAX_BYTES = String(1024 * 1024);
    let sync;
    jest.isolateModules(() => { sync = require('../utils/syncService'); });
    const meta = await sync.fetchEvaluationMetadata('Qm' + 'a'.repeat(44));
    // The manifest was refused, so no title came from it.
    expect(meta?.title ?? null).toBeNull();
  }, 60000);
});
