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
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'name and ownerAddress are required',
      });
    }

    // Validate name length
    if (name.length < 3 || name.length > 100) {
      return res.status(400).json({
        error: 'Invalid name',
        details: 'Name must be between 3 and 100 characters',
      });
    }

    // Validate wallet address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(ownerAddress)) {
      return res.status(400).json({
        error: 'Invalid ownerAddress',
        details: 'Must be a valid Ethereum address',
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
    });
  } catch (error) {
    logger.error('Bot registration failed', error);
    res.status(500).json({ error: 'Registration failed' });
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
    return res.status(404).json({ error: 'Bot not found' });
  }

  // Don't expose the API key
  const { apiKey, ...publicInfo } = bot;
  res.json({ bot: publicInfo });
});

/**
 * DELETE /api/bots/:id
 * Deactivate a bot (requires bot's own API key)
 */
router.delete('/:id', (req, res) => {
  // Only the bot itself can deactivate (must use its own API key)
  if (req.clientType !== 'bot' || req.clientId !== req.params.id) {
    return res.status(403).json({
      error: 'Unauthorized',
      details: 'Only the bot itself can deactivate its registration',
    });
  }

  const registry = loadBots();
  const bot = registry.bots.find(b => b.id === req.params.id);

  if (!bot) {
    return res.status(404).json({ error: 'Bot not found' });
  }

  bot.active = false;
  bot.deactivatedAt = new Date().toISOString();
  saveBots(registry);

  logger.info(`Bot deactivated: ${req.params.id}`);
  res.json({ success: true, message: 'Bot deactivated' });
});

module.exports = router;
