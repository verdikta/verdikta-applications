/**
 * utils/safeZip.js: evaluation packages are named on chain by anyone, so the sync and the wager checks
 * read them with bounded inflates and bounded downloads (zip bombs).
 */
const AdmZip = require('adm-zip');
const { readEntry: readZipEntry, readBodyCapped } = require('../utils/safeZip');

function zipWith(name, bytes) {
  const z = new AdmZip();
  z.addFile(name, bytes);
  return new AdmZip(z.toBuffer());
}

describe('readZipEntry', () => {
  test('reads a small entry', () => {
    const z = zipWith('manifest.json', Buffer.from('{"name":"x"}'));
    expect(JSON.parse(readZipEntry(z.getEntry('manifest.json')).toString())).toEqual({ name: 'x' });
  });
  test('refuses an entry that inflates past the limit, before inflating it', () => {
    const z = zipWith('manifest.json', Buffer.alloc(3 * 1024 * 1024, 32));
    const entry = z.getEntry('manifest.json');
    const spy = jest.spyOn(entry, 'getData');
    expect(() => readZipEntry(entry, 1024 * 1024)).toThrow(/limit/);
    expect(spy).not.toHaveBeenCalled();
  });
  test('caps an entry that declares size 0 but carries compressed data (that lifts AdmZip\'s own inflate cap)', () => {
    const z = zipWith('manifest.json', Buffer.alloc(3 * 1024 * 1024, 32));
    const entry = z.getEntry('manifest.json');
    entry.header.size = 0;
    expect(() => readZipEntry(entry, 1024 * 1024)).toThrow(/inflates past/);
  });
});

describe('readBodyCapped', () => {
  const body = (chunks, len) => ({
    headers: { get: (h) => (h === 'content-length' && len != null ? String(len) : null) },
    body: new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }),
  });
  test('reads a body under the cap', async () => {
    expect((await readBodyCapped(body([new Uint8Array([1, 2, 3])]), 10)).length).toBe(3);
  });
  test('refuses by Content-Length', async () => {
    await expect(readBodyCapped(body([], 1e9), 10)).rejects.toThrow(/limit/);
  });
  test('refuses a stream that runs past the cap without a Content-Length', async () => {
    await expect(readBodyCapped(body([new Uint8Array(8), new Uint8Array(8)]), 10)).rejects.toThrow(/exceeds/);
  });
});
