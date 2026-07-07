/**
 * Alerts routes — inbound arbiter watchdog webhooks + the UI read path.
 *
 * Arbiter nodes run `chainlink-health-watchdog.sh` (verdikta-arbiter repo)
 * from cron. When an operator sets:
 *
 *   WATCHDOG_ALERT_WEBHOOK="https://arbiters.verdikta.org/api/alerts"
 *   WATCHDOG_ALERT_TOKEN="<shared token>"
 *
 * in their node's installer/.env, every watchdog run POSTs one JSON event here
 * (OK heartbeat / ALERT / RECOVERED, keyed by on-chain operator address).
 * The Analytics page reads the aggregate view via GET /api/alerts.
 *
 * Ingest auth: a single shared token (env ALERTS_INGEST_TOKEN) compared
 * against the X-Watchdog-Token header. If the env var is unset, ingestion is
 * disabled (503) — never open by default. As defense in depth, the reported
 * operator address is checked against the on-chain keeper registry (cached
 * enumeration); events for unknown operators are rejected. Registry lookup
 * failures don't block ingest (the event is stored with registered=null).
 */

const express = require('express');
const router = express.Router();

const logger = require('../utils/logger');
const AlertStore = require('../utils/alertStore');
const { getVerdiktaService } = require('../utils/verdiktaService');
const { normalizeNetwork } = require('../config');

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const STATUSES = new Set(['OK', 'ALERT', 'RECOVERED']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);

// Staleness window for "arbiter stopped reporting". Watchdogs heartbeat every
// ~2 minutes, so 10 minutes = several consecutive missed runs.
const STALE_AFTER_MS = (parseInt(process.env.ALERTS_STALE_AFTER_MINUTES, 10) || 10) * 60 * 1000;

/**
 * Is this operator address registered in the keeper registry? Uses the
 * service's cached enumeration (10-minute tolerance) so heartbeats from many
 * arbiters share one registry walk.
 * @returns {Promise<boolean|null>} null when the registry could not be read.
 */
async function isRegisteredOperator(networkKey, operator) {
  try {
    const service = getVerdiktaService(networkKey);
    const oracles = await service.getAllOracles({ maxAgeMs: 10 * 60 * 1000 });
    const target = operator.toLowerCase();
    return oracles.some((o) => !o.error && o.oracle && o.oracle.toLowerCase() === target);
  } catch (err) {
    logger.warn('[alerts] registry check failed (accepting unverified)', {
      network: networkKey, msg: err.message,
    });
    return null;
  }
}

/**
 * POST /api/alerts
 * Ingest one watchdog event. Body: the watchdog's JSON payload (see
 * chainlink-health-watchdog.sh post_status_webhook).
 */
router.post('/', async (req, res) => {
  const ingestToken = process.env.ALERTS_INGEST_TOKEN;
  if (!ingestToken) {
    return res.status(503).json({ success: false, error: 'Alerts ingestion is not configured on this server' });
  }
  if (req.get('X-Watchdog-Token') !== ingestToken) {
    return res.status(401).json({ success: false, error: 'Invalid or missing X-Watchdog-Token' });
  }

  const body = req.body || {};
  const { operator, status } = body;
  if (!ADDR_RE.test(operator || '')) {
    return res.status(400).json({ success: false, error: 'Invalid operator address' });
  }
  if (!STATUSES.has(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status (expected OK | ALERT | RECOVERED)' });
  }

  // The watchdog reports DEPLOYMENT_NETWORK ('base_sepolia' | 'base_mainnet');
  // normalizeNetwork maps underscores, and 'base_mainnet' needs the explicit
  // alias since the canonical mainnet key is just 'base'.
  const rawNetwork = String(body.network || '').toLowerCase();
  const networkKey = normalizeNetwork(rawNetwork === 'base_mainnet' ? 'base' : rawNetwork);

  const registered = await isRegisteredOperator(networkKey, operator);
  if (registered === false) {
    logger.warn('[alerts] rejected event for unregistered operator', { network: networkKey, operator });
    return res.status(422).json({ success: false, error: 'Operator is not registered on this network' });
  }

  try {
    const store = AlertStore.forNetwork(networkKey).load();
    store.ingest({
      operator,
      hostname: typeof body.hostname === 'string' ? body.hostname.slice(0, 100) : null,
      status,
      severity: SEVERITIES.has(body.severity) ? body.severity : 'warning',
      subject: typeof body.subject === 'string' ? body.subject.slice(0, 300) : '',
      problems: Array.isArray(body.problems)
        ? body.problems.filter((p) => typeof p === 'string').map((p) => p.slice(0, 500)).slice(0, 20)
        : [],
      selfHeal: typeof body.selfHeal === 'string' ? body.selfHeal.slice(0, 300) : null,
      registered,
    });
    if (status !== 'OK') {
      logger.info('[alerts] event ingested', { network: networkKey, operator, status });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('[alerts] ingest failed', { network: networkKey, operator, msg: err.message });
    return res.status(500).json({ success: false, error: 'Failed to store alert event' });
  }
});

/**
 * GET /api/alerts?network=
 * Current reporting state for every operator that has ever reported, plus the
 * staleness window. Operators registered on-chain that never configured the
 * watchdog webhook simply don't appear (the UI labels them "not reporting").
 */
router.get('/', (req, res) => {
  const networkKey = normalizeNetwork(req.query.network);
  try {
    const store = AlertStore.forNetwork(networkKey).load();
    const data = store.getSnapshot({ staleAfterMs: STALE_AFTER_MS });
    return res.json({ success: true, data: { network: networkKey, ...data } });
  } catch (err) {
    logger.error('[alerts] read failed', { network: networkKey, msg: err.message });
    return res.status(500).json({ success: false, error: 'Failed to read alerts' });
  }
});

module.exports = router;
