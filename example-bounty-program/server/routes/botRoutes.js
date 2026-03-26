/**
 * Bot Routes
 *
 * Handles bot registration and management:
 * - POST /api/bots/register - Self-service bot registration (public)
 * - GET /api/bots/:id - Get bot info (no API key returned)
 * - DELETE /api/bots/:id - Deactivate a bot (requires bot's own API key)
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { sendError, ErrorCodes } = require('../utils/apiErrors');

const router = express.Router();
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

/**
 * Save bot registry to disk
 */
function saveBots(registry) {
  const dir = path.dirname(BOTS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(BOTS_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Generate a secure API key for bots
 */
function generateApiKey() {
  return 'bot-' + crypto.randomBytes(24).toString('hex');
}

/**
 * POST /api/bots/register
 * Self-service bot registration
 *
 * Body: { name, ownerAddress, description? }
 * Returns: { bot, apiKey, warning }
 */
router.post('/register', async (req, res) => {
  try {
    const { name, ownerAddress, description } = req.body;

    // Validate required fields
    if (!name || !ownerAddress) {
      return sendError(res, 400, {
        code: ErrorCodes.BOT_MISSING_FIELDS,
        message: 'Missing required fields',
        details: `Received: ${!name ? 'name is missing' : ''}${!name && !ownerAddress ? ', ' : ''}${!ownerAddress ? 'ownerAddress is missing' : ''}`,
        fix: 'POST /api/bots/register with JSON body: { "name": "MyBot", "ownerAddress": "0x..." }',
        tips: [
          'name: 3-100 characters, your bot\'s display name',
          'ownerAddress: your Ethereum wallet address (0x + 40 hex chars)',
          'description: optional, what your bot does',
          'Full docs: GET /api/docs'
        ]
      });
    }

    // Validate name length
    if (name.length < 3 || name.length > 100) {
      return sendError(res, 400, {
        code: ErrorCodes.BOT_INVALID_NAME,
        message: 'Invalid bot name',
        details: `Name "${name}" is ${name.length} characters. Must be 3-100 characters.`,
        fix: 'Choose a name between 3 and 100 characters'
      });
    }

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(ownerAddress)) {
      return sendError(res, 400, {
        code: ErrorCodes.BOT_INVALID_ADDRESS,
        message: 'Invalid owner address',
        details: `"${ownerAddress}" is not a valid Ethereum address`,
        fix: 'Provide a valid Ethereum address: 0x followed by 40 hexadecimal characters (42 chars total)',
        tips: ['Example: 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18']
      });
    }

    const registry = loadBots();

    // Generate unique bot ID and API key
    const botId = `bot-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const apiKey = generateApiKey();

    const newBot = {
      id: botId,
      name,
      description: description || '',
      ownerAddress: ownerAddress.toLowerCase(),
      apiKey,
      registeredAt: new Date().toISOString(),
      active: true,
    };

    registry.bots.push(newBot);
    saveBots(registry);

    logger.info(`New bot registered: ${botId} by ${ownerAddress}`);

    // Return the API key (only shown once!)
    res.status(201).json({
      success: true,
      bot: {
        id: botId,
        name,
        ownerAddress: newBot.ownerAddress,
        registeredAt: newBot.registeredAt,
      },
      apiKey, // Only returned on registration!
      warning: 'Save this API key - it will not be shown again',
      tips: [
        'Pass your key as header: X-Bot-API-Key: YOUR_KEY',
        'List open bounties: GET /api/jobs?status=OPEN',
        'Full docs: GET /api/docs'
      ]
    });
  } catch (error) {
    logger.error('Bot registration failed', error);
    sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Registration failed',
      details: error.message,
      fix: 'Try again shortly. If the problem persists, check server health: GET /health'
    });
  }
});

/**
 * GET /api/bots/:id
 * Get bot info (no API key returned)
 */
router.get('/:id', (req, res) => {
  const registry = loadBots();
  const bot = registry.bots.find(b => b.id === req.params.id);

  if (!bot) {
    return sendError(res, 404, {
      code: ErrorCodes.NOT_FOUND,
      message: 'Bot not found',
      details: `No bot with ID "${req.params.id}"`,
      fix: 'Check the bot ID is correct'
    });
  }

  // Don't expose the API key
  const { apiKey, ...publicInfo } = bot;
  res.json({ success: true, bot: publicInfo });
});

/**
 * DELETE /api/bots/:id
 * Deactivate a bot (requires bot's own API key)
 */
router.delete('/:id', (req, res) => {
  // Only the bot itself can deactivate (must use its own API key)
  if (req.clientType !== 'bot' || req.clientId !== req.params.id) {
    return sendError(res, 403, {
      code: ErrorCodes.AUTH_INVALID,
      message: 'Unauthorized',
      details: 'Only the bot itself can deactivate its registration',
      fix: 'Use the bot\'s own API key in X-Bot-API-Key header to deactivate'
    });
  }

  const registry = loadBots();
  const bot = registry.bots.find(b => b.id === req.params.id);

  if (!bot) {
    return sendError(res, 404, {
      code: ErrorCodes.NOT_FOUND,
      message: 'Bot not found',
      details: `No bot with ID "${req.params.id}"`,
      fix: 'Check the bot ID is correct'
    });
  }

  bot.active = false;
  bot.deactivatedAt = new Date().toISOString();
  saveBots(registry);

  logger.info(`Bot deactivated: ${req.params.id}`);
  res.json({ success: true, message: 'Bot deactivated' });
});

module.exports = router;
