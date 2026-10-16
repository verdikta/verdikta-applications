/**
 * Fixed-window, in-memory rate limiter keyed by an arbitrary string (a client IP).
 *
 * Single-process only, like the rest of the server's in-memory state. Memory is
 * bounded: expired windows are swept once the table passes maxKeys, and if every
 * key is still live the oldest are dropped (that only ever loosens the limit).
 */

function createRateLimiter({ windowMs, max, maxKeys = 10000, now = () => Date.now() }) {
  const windows = new Map(); // key -> { start, count }

  function sweep(t) {
    for (const [key, w] of windows) {
      if (t - w.start >= windowMs) windows.delete(key);
    }
    while (windows.size > maxKeys) windows.delete(windows.keys().next().value);
  }

  /**
   * Count one request for `key`.
   * @returns {{ allowed: boolean, remaining: number, retryAfterSeconds: number }}
   */
  function hit(key) {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      if (!w && windows.size >= maxKeys) sweep(t);
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    w.count += 1;
    return {
      allowed: w.count <= max,
      remaining: Math.max(0, max - w.count),
      retryAfterSeconds: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)),
    };
  }

  return { hit, reset: () => windows.clear(), size: () => windows.size };
}

/**
 * The address to rate-limit a request by. `req.ip` is unusable for this: with
 * `trust proxy` on it is the leftmost X-Forwarded-For entry, which the client
 * writes. nginx overwrites X-Real-IP with the peer it saw, so that header is
 * trusted only when the request reached Express over loopback (from nginx).
 */
function clientAddress(req) {
  const peer = req.socket?.remoteAddress || '';
  const viaLocalProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const realIp = req.headers['x-real-ip'];
  if (viaLocalProxy && typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  return peer || 'unknown';
}

module.exports = { createRateLimiter, clientAddress };
