/**
 * Every server-side IPFS read (IPFSClient, sync metadata, archive shape check,
 * /diagnose probe, /api/ipfs fallback) uses config.ipfsReadGateways.
 */
describe('config.ipfsReadGateways', () => {
  const saved = process.env.IPFS_READ_GATEWAYS;
  afterEach(() => {
    if (saved === undefined) delete process.env.IPFS_READ_GATEWAYS; else process.env.IPFS_READ_GATEWAYS = saved;
    jest.resetModules();
  });
  const load = () => require('../config').config.ipfsReadGateways;

  it('leads with Filebase and never lists the retired cloudflare-ipfs.com', () => {
    delete process.env.IPFS_READ_GATEWAYS;
    const list = load();
    expect(list[0]).toBe('https://ipfs.filebase.io');
    expect(list.some((g) => g.includes('cloudflare-ipfs.com'))).toBe(false);
    expect(new Set(list).size).toBe(list.length);
  });

  it('IPFS_READ_GATEWAYS replaces the list (trimmed, slash-stripped, de-duplicated)', () => {
    process.env.IPFS_READ_GATEWAYS = ' https://a.example/ ,https://b.example,https://a.example';
    expect(load()).toEqual(['https://a.example', 'https://b.example']);
  });
});
