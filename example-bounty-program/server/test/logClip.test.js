// sec4-outside: an anonymous request's headers must not reach the log unclipped (disk-fill amplifier).
const logger = require('../utils/logger');

describe('logger clips request-derived strings', () => {
  let out;
  let spy;
  beforeEach(() => { out = []; spy = jest.spyOn(console, 'log').mockImplementation((s) => out.push(String(s))); });
  afterEach(() => spy.mockRestore());

  test('a 7 KB User-Agent in meta is written as at most LOG_MAX_STRING characters', () => {
    const ua = 'Z'.repeat(7000);
    logger.warn('Blocked unknown client', { userAgent: ua, origin: ua, nested: { referer: ua } });
    const line = out.join('\n');
    expect(line.length).toBeLessThan(3 * logger.LOG_MAX_STRING + 600);
    expect(line).toContain('more characters');
  });

  test('a long message is clipped too, short values are untouched', () => {
    logger.info('GET /' + 'a'.repeat(9000), { ip: '127.0.0.1' });
    expect(out[0].length).toBeLessThan(logger.LOG_MAX_STRING + 300);
    expect(out[0]).toContain("ip: '127.0.0.1'");
  });
});

describe('LOG_LEVEL is case-insensitive (the env templates say "info")', () => {
  test('level "info" drops debug lines', () => {
    const { Logger } = logger;
    const l = new Logger({ level: 'info' });
    const out = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)));
    l.debug('Client auth check', { path: '/x' });
    l.info('kept');
    spy.mockRestore();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('kept');
  });
});
