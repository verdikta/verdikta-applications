/**
 * Client Identification Middleware
 *
 * Identifies and authenticates clients accessing the API:
 * - Official frontend: X-Client-Key header + allowed Origin
 * - Registered bots: X-Bot-API-Key header
 * - Unknown clients: Blocked (401)
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Bot registry file path
const BOTS_FILE = path.join(__dirname, '..', 'data', 'bots.json');

/**
 * Load bot registry from disk
 */
function loadBots() {
  try {
    if (fs.existsSync(BOTS_FILE)) {
      return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
    }
  } catch (e) {
    logger.error('Failed to load bots registry', e);
  }
  return { bots: [] };
}

// Paths that don't require authentication (bot registration, health checks, diagnostics, receipts)
const PUBLIC_PATHS = [
  '/api/bots/register',
  '/health',
  '/api/diagnostics',
  '/r/',    // Receipt pages - must be public for social media crawlers (OG tags)
  '/og/',   // OG images for receipts - must be public for social media unfurling
];

/**
 * Check if a path is public (doesn't require authentication)
 */
function isPublicPath(reqPath) {
  return PUBLIC_PATHS.some(p => reqPath.startsWith(p));
}

/**
 * Client identification middleware
 *
 * Sets req.clientType and req.clientId based on authentication:
 * - 'frontend' for official web frontend
 * - 'bot' for registered bots (also sets req.botInfo)
 * - 'public' for unauthenticated public endpoints
 *
 * Blocks unknown clients with 401.
 */
function clientIdentification(req, res, next) {
  // Allow public paths without authentication
  if (isPublicPath(req.path)) {
    req.clientType = 'public';
    req.clientId = null;
    return next();
  }

  const origin = req.headers.origin || req.headers.referer || '';
  // Check both cases since proxies might lowercase headers
  const clientKey = req.headers['x-client-key'] || req.headers['X-Client-Key'];
  const botApiKey = req.headers['x-bot-api-key'] || req.headers['X-Bot-API-Key'];

  // Debug logging
  logger.info('Client auth check', {
    path: req.path,
    hasClientKey: !!clientKey,
    clientKeyValue: clientKey ? clientKey.substring(0, 8) + '...' : 'none',
    clientKeyMatch: clientKey === process.env.FRONTEND_CLIENT_KEY,
    expectedKey: process.env.FRONTEND_CLIENT_KEY ? process.env.FRONTEND_CLIENT_KEY.substring(0, 8) + '...' : 'NOT SET',
    origin: origin || '(none)',
    allHeaders: Object.keys(req.headers).join(', '),
  });

  // Parse allowed origins from environment
  const allowedOrigins = (process.env.FRONTEND_ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  // Check for official frontend authentication
  // Requires both: valid client key AND allowed origin
  const isAllowedOrigin = allowedOrigins.length === 0 ||
    !origin ||
    allowedOrigins.some(allowed => origin.startsWith(allowed));

  if (clientKey && clientKey === process.env.FRONTEND_CLIENT_KEY && isAllowedOrigin) {
    req.clientType = 'frontend';
    req.clientId = 'official-frontend';
    return next();
  }

  // Check for bot API key authentication
  if (botApiKey) {
    const registry = loadBots();
    const bot = registry.bots.find(b => b.apiKey === botApiKey && b.active);
    if (bot) {
      req.clientType = 'bot';
      req.clientId = bot.id;
      req.botInfo = bot;
      return next();
    }
  }

  // Block unknown clients
  logger.warn(`Blocked unknown client: ${req.method} ${req.path} from ${req.ip}`, {
    hasClientKey: !!clientKey,
    hasBotApiKey: !!botApiKey,
    origin: origin || '(none)',
  });

  return res.status(401).json({
    error: 'Authentication required',
    details: 'Valid X-Client-Key or X-Bot-API-Key header required',
  });
}

module.exports = clientIdentification;
