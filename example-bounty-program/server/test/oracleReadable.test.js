/**
 * Regression tests for the oracle-readability guard.
 *
 * The Verdikta oracle silently skips archive/binary attachments → score 0 with no
 * upload-time error. These cover the detection that now rejects such uploads before
 * the hunter spends the ETH prepay. The key gap was application/octet-stream being an
 * allowed mimetype, which let a .zip slip past isValidFileType.
 */
const {
  oracleUnreadableReason,
  detectBinaryContainer,
  isValidFileType,
} = require('../utils/validation');

describe('oracleUnreadableReason (extension + mimetype)', () => {
  it('flags a .zip sent with the generic application/octet-stream mimetype (the reported gap)', () => {
    // isValidFileType currently ACCEPTS this (octet-stream is allowlisted)...
    expect(isValidFileType('application/octet-stream', 'solution.zip')).toBe(true);
    // ...but the oracle-readability guard rejects it.
    expect(oracleUnreadableReason('application/octet-stream', 'solution.zip')).toMatch(/archive|score 0/i);
  });

  it('flags archives by mimetype even with an innocuous name', () => {
    expect(oracleUnreadableReason('application/zip', 'deliverable')).toBeTruthy();
    expect(oracleUnreadableReason('application/x-7z-compressed', 'a.7z')).toBeTruthy();
    expect(oracleUnreadableReason('application/x-msdownload', 'tool.exe')).toBeTruthy();
  });

  it('flags common archive/binary extensions', () => {
    for (const name of ['a.zip', 'a.tar', 'a.gz', 'a.tgz', 'a.7z', 'a.rar', 'a.jar', 'a.exe', 'a.wasm', 'a.dmg']) {
      expect(oracleUnreadableReason('application/octet-stream', name)).toBeTruthy();
    }
  });

  it('does NOT flag oracle-readable formats (text/code/docs/images)', () => {
    for (const [mime, name] of [
      ['text/plain', 'solution.txt'],
      ['text/markdown', 'README.md'],
      ['application/octet-stream', 'contract.sol'],
      ['application/json', 'data.json'],
      ['application/pdf', 'report.pdf'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx'],
      ['image/png', 'diagram.png'],
    ]) {
      expect(oracleUnreadableReason(mime, name)).toBeNull();
    }
  });
});

describe('detectBinaryContainer (magic bytes)', () => {
  it('detects a ZIP signature (PK\\x03\\x04) — catches renamed/generic archives', () => {
    const zip = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    expect(detectBinaryContainer(zip)).toBe('ZIP archive');
  });

  it('detects gzip, 7z, ELF, and Windows-executable signatures', () => {
    expect(detectBinaryContainer(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe('gzip archive');
    expect(detectBinaryContainer(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z archive');
    expect(detectBinaryContainer(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe('ELF binary');
    expect(detectBinaryContainer(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBe('Windows executable');
  });

  it('returns null for plain text content', () => {
    expect(detectBinaryContainer(Buffer.from('Here is my solution in prose.'))).toBeNull();
  });

  it('caller must exempt .docx (ZIP-based) — detector reports ZIP, but docx is allowed', () => {
    // A real .docx begins with PK; the detector flags it as ZIP and the route helper
    // exempts the .docx extension. This test documents that contract.
    const docxHead = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
    expect(detectBinaryContainer(docxHead)).toBe('ZIP archive');
  });
});
