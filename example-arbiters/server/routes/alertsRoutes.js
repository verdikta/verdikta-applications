/**
 * Alerts routes — inbound arbiter watchdog webhooks + the UI read path.
 *
 * Arbiter nodes run `chainlink-health-watchdog.sh` (verdikta-arbiter repo)
 * from cron. When an operator sets:
 *
 *   WATCHDOG_ALERT_WEBHOOK="https://arbiters.verdikta.org/api/alerts"
 *
 * in their node's installer/.env, every watchdog run POSTs one JSON event here
 * (OK heartbeat / ALERT / RECOVERED, keyed by on-chain operator address).
 * The Analytics page reads the aggregate view via GET /api/alerts.
 *
 * Ingest auth — signature only, self-service, no shared secrets: the
 * watchdog signs a canonical message with the operator owner's key (EIP-191
 * personal message — pure local computation on the node, no transaction/gas)
 * and sends `signer` + `sig` in the body. We recover the signer, require a
 * fresh `ts` (replay bound), and require the signer to equal the operator
 * contract's on-chain owner() (cached read). Any freshly installed,
 * registered arbiter can report immediately; unsigned events are rejected.
 * (A shared-token fallback existed briefly and was removed deliberately: a
 * leaked fleet-wide token would allow spoofing any operator's status,
 * including fake "healthy" heartbeats masking a real outage.)
 *
 * As defense in depth, the reported operator address is also checked against
 * the on-chain keeper registry (cached enumeration); events for unknown
 * operators are rejected. Registry lookup failures don't block ingest (the
 * event is stored with registered=null).
 */

const express = require('express');
const { ethers } = require('ethers');
const router = express.Router();

const logger = require('../utils/logger');
const AlertStore = require('../utils/alertStore');
const { getVerdiktaService } = require('../utils/verdiktaService');
const { normalizeNetwork } = require('../config');

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const STATUSES = new Set(['OK', 'ALERT', 'RECOVERED']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);

// Signed events must carry a timestamp within this window (replay bound).
const SIG_MAX_AGE_MS = 10 * 60 * 1000;

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
 * Verify a signed event: recover the EIP-191 signer of the canonical message
 * (must mirror chainlink-health-watchdog.sh post_status_webhook exactly) and
 * check it matches both the claimed `signer` and a fresh `ts`.
 * @returns {{ ok: true, signer: string } | { ok: false, error: string }}
 */
function verifyEventSignature(body) {
  const { operator, network, status, ts, signer, sig } = body;
  if (!ADDR_RE.test(signer || '')) return { ok: false, error: 'Invalid signer address' };
  const tsMs = Date.parse(ts || '');
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > SIG_MAX_AGE_MS) {
    return { ok: false, error: 'Signed event timestamp is missing or outside the freshness window' };
  }
  const message = `verdikta-arbiter-watchdog:v1:${String(operator).toLowerCase()}:${network}:${status}:${ts}`;
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, sig);
  } catch (_) {
    return { ok: false, error: 'Malformed signature' };
  }
  if (recovered.toLowerCase() !== signer.toLowerCase()) {
    return { ok: false, error: 'Signature does not match claimed signer' };
  }
  return { ok: true, signer: recovered };
}

/**
 * POST /api/alerts
 * Ingest one watchdog event. Body: the watchdog's JSON payload (see
 * chainlink-health-watchdog.sh post_status_webhook).
 */
router.post('/', async (req, res) => {
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

  // ── Authentication: owner signature required ─────────────────────────────
  if (!body.sig || !body.signer) {
    return res.status(401).json({ success: false, error: 'Signature required (signer + sig, signed by the operator owner key)' });
  }
  const check = verifyEventSignature(body);
  if (!check.ok) {
    return res.status(401).json({ success: false, error: check.error });
  }
  let owner = null;
  try {
    const service = getVerdiktaService(networkKey);
    const ownerMap = await service.getOwnerMap([operator]);
    owner = ownerMap[operator.toLowerCase()] || null;
  } catch (err) {
    logger.warn('[alerts] owner lookup failed', { network: networkKey, operator, msg: err.message });
  }
  if (!owner) {
    return res.status(503).json({ success: false, error: 'Could not verify operator owner on-chain; retry later' });
  }
  if (owner.toLowerCase() !== check.signer.toLowerCase()) {
    logger.warn('[alerts] signer is not the operator owner', {
      network: networkKey, operator, signer: check.signer, owner,
    });
    return res.status(403).json({ success: false, error: 'Signer is not the operator owner' });
  }

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
      // Node telemetry (informational). Bounded to sane ranges.
      hostUptimeSec: Number.isFinite(body.hostUptimeSec) && body.hostUptimeSec >= 0
        ? Math.min(Math.floor(body.hostUptimeSec), 10 * 365 * 86400) : null,
      chainlinkUptimeSec: Number.isFinite(body.chainlinkUptimeSec) && body.chainlinkUptimeSec >= 0
        ? Math.min(Math.floor(body.chainlinkUptimeSec), 10 * 365 * 86400) : null,
      chainlinkImage: typeof body.chainlinkImage === 'string' ? body.chainlinkImage.slice(0, 120) : null,
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
 * Arbiter (registered jobId) counts per operator from the keeper registry,
 * plus the network total. One chainlink node/operator typically backs many
 * arbiters, so the UI shows "1 node — backing 10 arbiters". Best-effort:
 * returns null when the registry cannot be read (cached 10 min otherwise).
 * @returns {Promise<{ byOperator: Object<string, number>, total: number } | null>}
 */
async function getArbiterCounts(networkKey) {
  try {
    const service = getVerdiktaService(networkKey);
    const oracles = await service.getAllOracles({ maxAgeMs: 10 * 60 * 1000 });
    const byOperator = {};
    let total = 0;
    for (const o of oracles) {
      if (o.error || !o.oracle) continue;
      const k = o.oracle.toLowerCase();
      byOperator[k] = (byOperator[k] || 0) + 1;
      total += 1;
    }
    return { byOperator, total };
  } catch (err) {
    logger.warn('[alerts] arbiter counts unavailable', { network: networkKey, msg: err.message });
    return null;
  }
}

/**
 * GET /api/alerts?network=
 * Current reporting state for every operator that has ever reported, plus the
 * staleness window and watchdog coverage (reporting arbiters vs. total
 * registered). Operators registered on-chain that never configured the
 * watchdog webhook simply don't appear (the UI labels them "not reporting").
 */
router.get('/', async (req, res) => {
  const networkKey = normalizeNetwork(req.query.network);
  try {
    const store = AlertStore.forNetwork(networkKey).load();
    const data = store.getSnapshot({ staleAfterMs: STALE_AFTER_MS });

    // Enrich with per-operator arbiter counts + network coverage (best-effort).
    const counts = await getArbiterCounts(networkKey);
    let coverage = null;
    if (counts) {
      let covered = 0;
      for (const op of data.operators) {
        op.arbiters = counts.byOperator[op.operator.toLowerCase()] ?? 0;
        covered += op.arbiters;
      }
      coverage = {
        reportingNodes: data.operators.length,
        coveredArbiters: covered,
        totalArbiters: counts.total,
      };
    }

    return res.json({ success: true, data: { network: networkKey, ...data, coverage } });
  } catch (err) {
    logger.error('[alerts] read failed', { network: networkKey, msg: err.message });
    return res.status(500).json({ success: false, error: 'Failed to read alerts' });
  }
});

module.exports = router;
