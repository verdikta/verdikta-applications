/**
 * Simple logger utility
 * Provides structured logging with different levels
 */

const { redact } = require('./redact');

/** A copy of `v` with every string passed through redact() (RPC keys in error messages). */
function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redact(v);
  if (!v || typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x, depth + 1);
  return out;
}

const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

const colors = {
  ERROR: '\x1b[31m',
  WARN: '\x1b[33m',
  INFO: '\x1b[36m',
  DEBUG: '\x1b[90m',
  RESET: '\x1b[0m'
};

class Logger {
  constructor(config = {}) {
    this.level = config.level || process.env.LOG_LEVEL || 'INFO';
    this.enableColors = config.enableColors !== false;
  }

  log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const color = this.enableColors ? colors[level] : '';
    const reset = this.enableColors ? colors.RESET : '';

    if (this.shouldLog(level)) {
      console.log(`${color}[${timestamp}] [${level}] ${redact(String(message))}${reset}`, redactDeep(meta));
    }
  }

  shouldLog(level) {
    const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  error(message, meta = {}) { this.log(LOG_LEVELS.ERROR, message, meta); }
  warn(message, meta = {})  { this.log(LOG_LEVELS.WARN,  message, meta); }
  info(message, meta = {})  { this.log(LOG_LEVELS.INFO,  message, meta); }
  debug(message, meta = {}) { this.log(LOG_LEVELS.DEBUG, message, meta); }
}

module.exports = new Logger();
