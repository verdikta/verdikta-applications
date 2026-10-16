/**
 * Small in-memory TTL cache with in-flight de-duplication.
 *
 * get(key, load) returns the cached value while it is fresh; otherwise it calls
 * load() once and shares that promise with every concurrent caller for the same
 * key (several jurors opening the same link at once cost one upstream read).
 * A value is kept only if shouldCache(value) says so; a rejected load is never
 * kept. Entries are bounded by maxEntries (oldest dropped first).
 *
 * Resolves to { value, cached }: cached is true when this call did not trigger
 * the load (it reused a stored value or joined one already in flight).
 */

function createTtlCache({ ttlMs, maxEntries = 1000, shouldCache = () => true, now = () => Date.now() }) {
  const entries = new Map(); // key -> { promise, storedAt }

  function get(key, load) {
    const t = now();
    const entry = entries.get(key);
    if (entry && (entry.storedAt === null || t - entry.storedAt < ttlMs)) {
      return entry.promise.then(value => ({ value, cached: true }));
    }

    const fresh = { promise: null, storedAt: null };
    fresh.promise = Promise.resolve().then(load).then(
      value => {
        if (entries.get(key) === fresh) {
          if (shouldCache(value)) fresh.storedAt = now();
          else entries.delete(key);
        }
        return value;
      },
      err => {
        if (entries.get(key) === fresh) entries.delete(key);
        throw err;
      }
    );
    entries.delete(key);
    entries.set(key, fresh);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return fresh.promise.then(value => ({ value, cached: false }));
  }

  return { get, clear: () => entries.clear(), size: () => entries.size };
}

module.exports = { createTtlCache };
