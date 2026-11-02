// Watching a pending evaluation (node P6b). A revealed claim waits for the arbiters' verdict, a
// disputed one for the dispute panel's; the site's keeper records either on-chain with finalize
// (erratum E4). A verdict usually takes 3 to 6 minutes and 15 at worst (design §11), so the page
// reads the chain every POLL_MS for up to WATCH_MS, then stops and says so.
export const POLL_MS = 5000;
export const WATCH_MS = 15 * 60 * 1000;

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
    return undefined;
  });
}

/**
 * Calls `read` now and every `intervalMs` until `done(value)`, or until `maxMs` has passed since
 * the first read (the last read falls at maxMs). A read that throws is passed to `onError` and the
 * watch goes on.
 *
 * @template T
 * @param {object} o
 * @param {() => Promise<T>} o.read
 * @param {(value: T) => boolean} o.done
 * @param {(value: T) => void} [o.onValue]
 * @param {(err: unknown) => void} [o.onError]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ outcome: 'done', value: T } | { outcome: 'timeout', value: T|undefined } | { outcome: 'aborted' }>}
 */
export async function watchUntil({
  read,
  done,
  onValue = () => {},
  onError = () => {},
  intervalMs = POLL_MS,
  maxMs = WATCH_MS,
  signal,
  now = Date.now,
  sleep = (ms) => abortableSleep(ms, signal),
}) {
  const start = now();
  let last;
  for (;;) {
    if (signal?.aborted) return { outcome: 'aborted' };
    try {
      const value = await read();
      if (signal?.aborted) return { outcome: 'aborted' };
      last = value;
      onValue(value);
      if (done(value)) return { outcome: 'done', value };
    } catch (err) {
      if (signal?.aborted) return { outcome: 'aborted' };
      onError(err);
    }
    const left = start + maxMs - now();
    if (left <= 0) return { outcome: 'timeout', value: last };
    await sleep(Math.min(intervalMs, left));
  }
}
