/**
 * Class registry + coverage endpoints.
 *
 * Classes are permissionless: anyone can run arbiters for a new class ID, so a
 * class outside the @verdikta/common registry is answered with status UNLISTED
 * (200), not a 404. Only registry classes carry a model list. Live arbiter
 * coverage comes from the on-chain ReputationKeeper. See utils/classPolicy.js.
 */
const express = require('express');
const { classMap } = require('@verdikta/common');
const { config } = require('../config');
const logger = require('../utils/logger');
const { checkClassCoverage } = require('../utils/classPolicy');
const { parseFeeToWei } = require('../utils/validation');

const router = express.Router();

// ClassMap API endpoints (reused from example-frontend)
router.get('/api/classes', (req, res) => {
  try {
    const { status, provider } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (provider) filter.provider = provider;

    const classes = classMap.listClasses(filter);

    // Convert BigInt IDs and fetch full class details including description
    const serializedClasses = classes.map(cls => {
      const fullClass = classMap.getClass(Number(cls.id));
      return {
        id: Number(cls.id),
        status: cls.status,
        name: cls.name,
        description: fullClass?.description || '' // Get description from full class object
      };
    });

    res.json({
      success: true,
      classes: serializedClasses,
      classMapVersion: typeof classMap.getMapVersion === 'function' ? classMap.getMapVersion() : null,
      source: '@verdikta/common',
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching classes:', error);
    res.status(500).json({
      error: 'Failed to fetch classes',
      details: error.message
    });
  }
});

/**
 * GET /api/classes/presets[?usd=<bounty amount in USD>]
 * The bounty size classes (TODO item 15): the jury { K, M, N, P, timeout } each request carries,
 * the Q-of-N pass quota, the forfeit line R, the hunter bond and the per-juror fee floor (USD),
 * beacons, cost per round and the largest bounty each is offered for. They are defaults: the
 * creator may override every value on POST /jobs/create. With ?usd= the response names the
 * suggested class; wei values use the server's ETH/USD price when it can be read.
 * Registered before /api/classes/:classId so "presets" is not read as a class id.
 */
router.get('/api/classes/presets', async (req, res) => {
  const presets = require('../../shared/classPresets');
  let ethUsd = null;
  try { ethUsd = (await require('../utils/ethPrice').getEthPriceUsd()).usd; } catch { /* USD only */ }
  const usd = req.query.usd != null && req.query.usd !== '' ? Number(req.query.usd) : null;
  const classes = presets.CLASS_PRESETS.map((c) => {
    let wei = null;
    if (ethUsd) {
      try {
        const p = presets.toBountyParams(c.key, ethUsd);
        wei = { bond: p.bond, minOracleFee: p.minOracleFee };
      } catch { wei = null; }
    }
    return { ...c, wei };
  });
  res.json({
    success: true,
    classes,
    suggested: Number.isFinite(usd) && usd > 0 ? presets.presetForBounty(usd)?.key ?? null : null,
    ethUsd,
    maxRounds: presets.MAX_ROUNDS,
    rerunWindowSeconds: presets.RERUN_WINDOW_SECONDS,
    note: 'Defaults only: the bounty creator sets jury, quota, forfeitLine, bond, oracleMinOracleFee and oracleWithBeacons on POST /jobs/create (bountyClass picks a preset).'
  });
});

const UNLISTED_CLASS_NOTE = 'This class is not in the Verdikta class registry. That is allowed: anyone can run arbiters for a new class and define what it means. The platform has no model list for it, so use the provider/model identifiers its arbiter operators advertise, and check GET /api/classes/:classId/coverage for live arbiters.';
const unlistedClassName = (classId) => `Custom class ${classId}`;

// Get specific class information
router.get('/api/classes/:classId', (req, res) => {
  try {
    const classId = parseInt(req.params.classId, 10);

    if (isNaN(classId)) {
      return res.status(400).json({
        error: 'Invalid class ID',
        details: 'Class ID must be a number'
      });
    }

    const classInfo = classMap.getClass(classId);

    if (!classInfo) {
      return res.json({
        success: true,
        listed: false,
        class: { id: classId, name: unlistedClassName(classId), status: 'UNLISTED', description: '', models: [] },
        message: UNLISTED_CLASS_NOTE,
        classMapVersion: typeof classMap.getMapVersion === 'function' ? classMap.getMapVersion() : null,
        source: '@verdikta/common',
        generatedAt: new Date().toISOString()
      });
    }

    // Convert BigInt ID to regular number for JSON serialization
    const serializedClass = {
      ...classInfo,
      id: Number(classInfo.id),
      description: classInfo.description || '' // Include description field
    };

    res.json({
      success: true,
      listed: true,
      class: serializedClass,
      classMapVersion: typeof classMap.getMapVersion === 'function' ? classMap.getMapVersion() : null,
      source: '@verdikta/common',
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching class:', error);
    res.status(500).json({
      error: 'Failed to fetch class',
      details: error.message
    });
  }
});

// Get available models for a specific class
router.get('/api/classes/:classId/models', (req, res) => {
  try {
    const classId = parseInt(req.params.classId, 10);

    if (isNaN(classId)) {
      return res.status(400).json({
        error: 'Invalid class ID',
        details: 'Class ID must be a number'
      });
    }

    const classInfo = classMap.getClass(classId);

    if (!classInfo) {
      return res.json({
        success: true,
        listed: false,
        classId,
        className: unlistedClassName(classId),
        description: '',
        status: 'UNLISTED',
        models: [],
        modelsByProvider: {},
        limits: null,
        message: UNLISTED_CLASS_NOTE,
        classMapVersion: typeof classMap.getMapVersion === 'function' ? classMap.getMapVersion() : null,
        source: '@verdikta/common',
        generatedAt: new Date().toISOString()
      });
    }

    // Check if class is empty (no models available)
    if (classInfo.status === 'EMPTY') {
      return res.json({
        success: false,
        status: 'EMPTY',
        error: 'This class has no available models',
        classId: Number(classInfo.id),
        className: classInfo.name
      });
    }

    // Group models by provider
    const modelsByProvider = {};
    if (classInfo.models && Array.isArray(classInfo.models)) {
      classInfo.models.forEach(model => {
        if (!modelsByProvider[model.provider]) {
          modelsByProvider[model.provider] = [];
        }
        modelsByProvider[model.provider].push(model);
      });
    }

    // Convert BigInt ID to regular number for JSON serialization
    const response = {
      success: true,
      listed: true,
      classId: Number(classInfo.id),
      className: classInfo.name,
      description: classInfo.description || '', // Include description field
      status: classInfo.status,
      models: classInfo.models || [],
      modelsByProvider,
      limits: classInfo.limits || null,
      classMapVersion: typeof classMap.getMapVersion === 'function' ? classMap.getMapVersion() : null,
      source: '@verdikta/common',
      generatedAt: new Date().toISOString()
    };

    res.json(response);
  } catch (error) {
    logger.error('Error fetching models for class:', error);
    res.status(500).json({
      error: 'Failed to fetch models',
      details: error.message
    });
  }
});

// Live arbiter coverage for any class (listed or not), read from the on-chain
// ReputationKeeper. Lets creators and agents see who can serve a class before
// creating a bounty for it. Optional ?maxOracleFee= (decimal ETH or integer wei)
// defaults to the server's default bounty fee limit; only arbiters priced at or
// below it can be selected. ?bountyClass= picks the size-class preset whose jury K is
// checked (default small). With fewer than K distinct eligible arbiters the keeper repeats
// arbiters (a warning); only none makes the class unservable.
router.get('/api/classes/:classId/coverage', async (req, res) => {
  const classId = Number(req.params.classId);
  if (!Number.isSafeInteger(classId) || classId < 0) {
    return res.status(400).json({ error: 'Invalid class ID', details: 'Class ID must be a non-negative integer' });
  }
  let maxOracleFee;
  try {
    maxOracleFee = parseFeeToWei(req.query.maxOracleFee ?? config.submissionDefaults.maxOracleFeeWei, 'maxOracleFee');
  } catch (err) {
    return res.status(400).json({ error: 'Invalid maxOracleFee', details: err.message });
  }
  if (maxOracleFee <= 0n) {
    return res.status(400).json({ error: 'Invalid maxOracleFee', details: 'maxOracleFee must be > 0' });
  }

  const { presetByKey, CLASS_PRESETS } = require('../../shared/classPresets');
  const preset = presetByKey(req.query.bountyClass || 'small');
  if (!preset) {
    return res.status(400).json({ error: 'Invalid bountyClass', details: `bountyClass must be one of ${CLASS_PRESETS.map((c) => c.key).join(', ')}` });
  }

  const classInfo = classMap.getClass(classId);
  const { coverage, refusal, warnings } = await checkClassCoverage(classId, {
    maxOracleFee: maxOracleFee.toString(),
    alpha: Number(config.submissionDefaults.alpha),
    estimatedBaseCost: String(config.submissionDefaults.estimatedBaseCostWei),
    maxFeeBasedScaling: Number(config.submissionDefaults.maxFeeBasedScaling),
    withBeacons: preset.withBeacons
  }, { jury: { ...preset.jury } });
  res.json({
    success: true,
    classId,
    listed: !!classInfo,
    className: classInfo ? classInfo.name : unlistedClassName(classId),
    // false when the chain was read and no arbiter is eligible, so every draw would fail
    // (fewer than the jury's K is a warning: the draw repeats arbiters); null when coverage
    // could not be checked.
    servable: coverage.checked ? !refusal : null,
    refusal,
    coverage,
    warnings
  });
});

module.exports = router;
