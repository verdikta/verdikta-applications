/**
 * Alert Store
 *
 * Persistent per-network store of arbiter watchdog reports. Each arbiter node
 * runs `chainlink-health-watchdog.sh` (verdikta-arbiter repo) from cron every
 * ~2 minutes; when its WATCHDOG_ALERT_WEBHOOK points at this server's
 * POST /api/alerts, every run delivers one JSON event:
 *
 *   status "OK"        — heartbeat (node checked out healthy)
 *   status "ALERT"     — node unhealthy (0 live RPC nodes, failing Chainlink
 *                        health checks, container down, …)
 *   status "RECOVERED" — transition back to healthy
 *
 * The store keeps the current state per operator address (the same key the
 * analytics tables use) plus a bounded history of state transitions. Because
 * healthy nodes heartbeat continuously, a *missing* heartbeat is itself a
 * signal: getSnapshot() derives a 'stale' state for operators that have not
 * reported within the staleness window — the only way to notice an arbiter
 * whose whole machine went dark.
 *
 * One JSON file per network at `server/data/{network}/alerts.json`, matching
 * the gasReceiptStore per-network data convention:
 *
 *   {
 *     "updatedAt": 1779848153911,
 *     "operators": {
 *       "0xabc…(lower)": {
 *         "operator": "0xAbC…",        // original-case address
 *         "hostname": "vps-1",
 *         "network": "base-sepolia",
 *         "firstSeen": 1779840000000,
 *         "lastSeen": 1779848150000,
 *         "lastStatus": "OK",
 *         "registered": true,           // operator found in keeper registry (null = unverified)
 *         "activeAlert": null | {
 *           "subject": "…", "severity": "critical", "problems": ["…"],
 *           "selfHeal": "…" | null, "since": ms, "lastEventAt": ms
 *         },
 *         "history": [ { ts, status, severity, subject, problems } ]  // newest first, bounded
 *       }
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_ROOT = path.join(__dirname, '..', 'data');
const FILE_NAME = 'alerts.json';
const HISTORY_LIMIT = 50;

// One store per network, lazily loaded and reused across requests.
const _instances = {};

class AlertStore {
  /**
   * @param {string} networkKey canonical network key ('base' | 'base-sepolia').
   */
  constructor(networkKey) {
    this.networkKey = networkKey;
    this.filePath = path.join(DATA_ROOT, networkKey, FILE_NAME);
    this.operators = {};   // operatorLower → record
    this._dirty = false;
    this._loaded = false;
  }

  /** Cached per-network singleton. */
  static forNetwork(networkKey) {
    if (!_instances[networkKey]) _instances[networkKey] = new AlertStore(networkKey);
    return _instances[networkKey];
  }

  /** Load from disk once (idempotent). Missing/corrupt file → empty store. */
  load() {
    if (this._loaded) return this;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.operators = parsed.operators || {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('alertStore: could not read store, starting empty', {
          network: this.networkKey, file: this.filePath, msg: err.message,
        });
      }
      this.operators = {};
    }
    this._loaded = true;
    return this;
  }

  /**
   * Ingest one watchdog event (already validated by the route). Updates the
   * operator's current state and appends to history only on state transitions
   * or when an active alert's content changes — heartbeats just bump lastSeen,
   * so a 2-minute cron cannot flood the history.
   *
   * @param {{ operator: string, hostname?: string, status: 'OK'|'ALERT'|'RECOVERED',
   *   severity?: string, subject?: string, problems?: string[], selfHeal?: string|null,
   *   registered?: boolean|null, hostUptimeSec?: number|null,
   *   chainlinkUptimeSec?: number|null, chainlinkImage?: string|null }} event
   * @returns {object} the updated operator record
   */
  ingest(event) {
    const key = event.operator.toLowerCase();
    const now = Date.now();

    if (!this.operators[key]) {
      this.operators[key] = {
        operator: event.operator,
        hostname: event.hostname || null,
        network: this.networkKey,
        firstSeen: now,
        lastSeen: now,
        lastStatus: null,
        registered: null,
        activeAlert: null,
        history: [],
      };
    }
    const rec = this.operators[key];
    rec.lastSeen = now;
    if (event.hostname) rec.hostname = event.hostname;
    if (event.registered != null) rec.registered = event.registered;
    // Node telemetry (informational; sent with every event, kept current)
    if (event.hostUptimeSec != null) rec.hostUptimeSec = event.hostUptimeSec;
    if (event.chainlinkUptimeSec != null) rec.chainlinkUptimeSec = event.chainlinkUptimeSec;
    if (event.chainlinkImage) rec.chainlinkImage = event.chainlinkImage;

    const pushHistory = (entry) => {
      rec.history.unshift({ ts: now, ...entry });
      if (rec.history.length > HISTORY_LIMIT) rec.history.length = HISTORY_LIMIT;
    };

    if (event.status === 'ALERT') {
      const subject = event.subject || 'arbiter unhealthy';
      const problems = Array.isArray(event.problems) ? event.problems : [];
      const changed = !rec.activeAlert
        || rec.activeAlert.subject !== subject
        || JSON.stringify(rec.activeAlert.problems) !== JSON.stringify(problems);
      if (!rec.activeAlert) {
        rec.activeAlert = {
          subject,
          severity: event.severity || 'warning',
          problems,
          selfHeal: event.selfHeal || null,
          since: now,
          lastEventAt: now,
        };
      } else {
        rec.activeAlert.subject = subject;
        rec.activeAlert.severity = event.severity || rec.activeAlert.severity;
        rec.activeAlert.problems = problems;
        rec.activeAlert.selfHeal = event.selfHeal || rec.activeAlert.selfHeal;
        rec.activeAlert.lastEventAt = now;
      }
      if (changed) {
        pushHistory({ status: 'ALERT', severity: rec.activeAlert.severity, subject, problems });
      }
    } else if (event.status === 'RECOVERED' || event.status === 'OK') {
      if (rec.activeAlert) {
        pushHistory({
          status: 'RECOVERED',
          severity: 'info',
          subject: event.subject || 'healthy again',
          problems: [],
        });
        rec.activeAlert = null;
      }
    }

    rec.lastStatus = event.status;
    this._dirty = true;
    this.flush();
    return rec;
  }

  /**
   * Current view for the UI. Derives a per-operator reporting state:
   *   'alerting' — active alert
   *   'stale'    — no heartbeat within staleAfterMs (node/machine may be dark)
   *   'ok'       — heartbeating and healthy
   *
   * @param {{ staleAfterMs?: number }} opts
   */
  getSnapshot({ staleAfterMs = 10 * 60 * 1000 } = {}) {
    const now = Date.now();
    const operators = Object.values(this.operators).map((rec) => {
      let state = 'ok';
      if (rec.activeAlert) state = 'alerting';
      else if (now - rec.lastSeen > staleAfterMs) state = 'stale';
      return { ...rec, state };
    });
    // Alerting first, then stale, then ok; ties by most recently seen.
    const rank = { alerting: 0, stale: 1, ok: 2 };
    operators.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.lastSeen - a.lastSeen));
    return { operators, staleAfterMs, generatedAt: now };
  }

  /**
   * Atomically persist to disk if there are unsaved changes. Writes to a temp
   * file then renames so a crash mid-write can't corrupt the store.
   */
  flush() {
    if (!this._dirty) return;
    const payload = { updatedAt: Date.now(), operators: this.operators };
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.filePath);
      this._dirty = false;
    } catch (err) {
      logger.warn('alertStore: flush failed', {
        network: this.networkKey, file: this.filePath, msg: err.message,
      });
    }
  }
}

module.exports = AlertStore;
