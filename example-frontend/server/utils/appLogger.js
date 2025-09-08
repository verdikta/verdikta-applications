const winston = require('winston');

function sanitizeMeta(value, seen = new WeakSet()) {
  try {
    if (value == null) return value;
    if (Buffer.isBuffer(value)) return { type: 'Buffer', length: value.length };
    const t = typeof value;
    if (t === 'string') {
      return value.length > 1000
        ? `${value.slice(0, 1000)}…[truncated ${value.length - 1000} chars]`
        : value;
    }
    if (t !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => sanitizeMeta(item, seen));
    }
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitizeMeta(value[k], seen);
    return out;
  } catch (_) {
    return '[Unserializable meta]';
  }
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

module.exports = {
  info(message, meta = {}) {
    logger.info(message, sanitizeMeta(meta));
  },
  error(message, meta = {}) {
    logger.error(message, sanitizeMeta(meta));
  },
  warn(message, meta = {}) {
    logger.warn(message, sanitizeMeta(meta));
  },
  debug(message, meta = {}) {
    logger.debug(message, sanitizeMeta(meta));
  }
};



