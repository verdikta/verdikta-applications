/**
 * Simple logger utility for the bounty server
 * Provides structured logging with different levels
 */

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
    this.level = config.level || process.env.LOG_LEVEL || 'INFO';
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
      console.log(`${color}[${timestamp}] [${level}] ${message}${reset}`, meta);
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
    if (Object.values(LOG_LEVELS).includes(level)) {
      this.level = level;
    }
  }
}

// Export singleton instance
module.exports = new Logger();



