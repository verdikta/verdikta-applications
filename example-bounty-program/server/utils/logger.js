/**
 * Simple logger utility for the bounty server
 * Provides structured logging with different levels
 */

const util = require('util');
const { redact } = require('./redactSecrets');

// Request-derived strings (User-Agent, Origin/Referer, paths, bodies quoted in errors) reach the log
// from anonymous callers. Unclipped, one request with 7 KB headers wrote 12.5 KB of log, and the
// services append stdout to a file with no rotation, so a single client filled the host's disk at
// about 5 MB/s (sec4-outside). Every string is clipped at LOG_MAX_STRING characters.
const LOG_MAX_STRING = Math.max(64, parseInt(process.env.LOG_MAX_STRING, 10) || 512);
const clip = (s) => (typeof s === 'string' && s.length > LOG_MAX_STRING
  ? `${s.slice(0, LOG_MAX_STRING)}... (${s.length - LOG_MAX_STRING} more characters)` : s);

const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

const colors = {
  ERROR: '\x1b[31m', // Red
  WARN: '\x1b[33m',  // Yellow
  INFO: '\x1b[36m',  // Cyan
  DEBUG: '\x1b[90m', // Gray
  RESET: '\x1b[0m'
};

class Logger {
  constructor(config = {}) {
    // Upper-cased: the env templates say LOG_LEVEL=info, and an unknown level used to log DEBUG too.
    this.level = String(config.level || process.env.LOG_LEVEL || 'INFO').toUpperCase();
    if (!Object.values(LOG_LEVELS).includes(this.level)) this.level = 'INFO';
    this.enableColors = config.enableColors !== false;
  }

  log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const color = this.enableColors ? colors[level] : '';
    const reset = this.enableColors ? colors.RESET : '';
    
    const logEntry = {
      timestamp,
      level,
      message,
      ...meta
    };

    if (this.shouldLog(level)) {
      // Redacted: ethers errors embed the RPC URL (and its key) in their messages.
      console.log(redact(util.formatWithOptions({ maxStringLength: LOG_MAX_STRING },
        `${color}[${timestamp}] [${level}] ${clip(String(message))}${reset}`, meta)));
    }
  }

  shouldLog(level) {
    const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  error(message, meta = {}) {
    this.log(LOG_LEVELS.ERROR, message, meta);
  }

  warn(message, meta = {}) {
    this.log(LOG_LEVELS.WARN, message, meta);
  }

  info(message, meta = {}) {
    this.log(LOG_LEVELS.INFO, message, meta);
  }

  debug(message, meta = {}) {
    this.log(LOG_LEVELS.DEBUG, message, meta);
  }

  setLevel(level) {
    level = String(level || '').toUpperCase();
    if (Object.values(LOG_LEVELS).includes(level)) {
      this.level = level;
    }
  }
}

// Export singleton instance
module.exports = new Logger();
module.exports.LOG_MAX_STRING = LOG_MAX_STRING;
module.exports.Logger = Logger;



