// sec4-outside: LOG_LEVEL=info (the env templates' spelling) must not turn on debug logging.
const test = require('node:test');
const assert = require('node:assert');
const { Logger } = require('../utils/logger');

test('a lower-case LOG_LEVEL is honoured', () => {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try {
    const l = new Logger({ level: 'info', enableColors: false });
    l.debug('noise');
    l.info('kept');
  } finally { console.log = orig; }
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /kept/);
});
