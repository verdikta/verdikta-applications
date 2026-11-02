// Watching a pending evaluation (node P6b). A revealed claim waits for the arbiters' verdict, a
// disputed one for the dispute panel's; the site's keeper records either on-chain with finalize
// (erratum E4). A verdict usually takes 3 to 6 minutes and 15 at worst (design §11), so the page
// reads the chain every POLL_MS for up to WATCH_MS, then stops and says so.
export const POLL_MS = 5000;
export const WATCH_MS = 15 * 60 * 1000;
/** The longest one read may take before it counts as failed. */
export const READ_TIMEOUT_MS = 30_000;

const TIMED_OUT = Symbol('timed out');
const ABORTED = Symbol('aborted');

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

/** Resolves when `signal` aborts; never without one. */
const aborted = (signal) => new Promise((resolve) => {
  if (!signal) return;
  if (signal.aborted) resolve();
  else signal.addEventListener('abort', () => resolve(), { once: true });
});

/**
 * Calls `read` now and every `intervalMs` until `done(value)`, or until `maxMs` has passed since
 * the start, the last read falling at maxMs. The limit holds while a read is pending too: each
 * read gets at most `readTimeoutMs`, and no more than the time left (or, for the last read, one
 * interval); a read that runs out counts as a failed read, and one still pending when the watch's
 * time is up ends it, its late answer ignored. An abort ends the watch at once. A read that
 * throws or times out is passed to `onError` and the watch goes on.
 *
 * @template T
 * @param {object} o
 * @param {() => Promise<T>} o.read
 * @param {(value: T) => boolean} o.done
 * @param {(value: T) => void} [o.onValue]
 * @param {(err: unknown) => void} [o.onError]
 * @param {AbortSignal} [o.signal]
 * @param {() => number} [o.now] - the clock (ms)
 * @param {(ms: number) => Promise<void>} [o.sleep] - the wait between reads
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [o.deadline] - resolves when `ms`
 *        more have passed, unless `signal` aborts first (then it may resolve or not): a pending
 *        read's limit
 * @returns {Promise<{ outcome: 'done', value: T } | { outcome: 'timeout', value: T|undefined } | { outcome: 'aborted' }>}
 */
export async function watchUntil({
  read,
  done,
  onValue = () => {},
  onError = () => {},
  intervalMs = POLL_MS,
  maxMs = WATCH_MS,
  readTimeoutMs = READ_TIMEOUT_MS,
  signal,
  now = Date.now,
  sleep = (ms) => abortableSleep(ms, signal),
  deadline = (ms, s) => abortableSleep(ms, s),
}) {
  const start = now();
  const stop = aborted(signal).then(() => ABORTED);
  let last;
  for (;;) {
    if (signal?.aborted) return { outcome: 'aborted' };
    const left = start + maxMs - now();
    const timer = new AbortController();
    let got;
    try {
      got = await Promise.race([
        Promise.resolve().then(read).then((value) => ({ value })),
        deadline(Math.min(readTimeoutMs, Math.max(left, intervalMs)), timer.signal).then(() => TIMED_OUT),
        stop,
      ]);
    } catch (err) {
      got = { error: err };
    } finally {
      timer.abort();
    }
    if (got === ABORTED || signal?.aborted) return { outcome: 'aborted' };
    if (got === TIMED_OUT) {
      if (now() - start >= maxMs) return { outcome: 'timeout', value: last };
      got = { error: new Error(`the read took longer than ${readTimeoutMs} ms`) };
    }
    if ('error' in got) onError(got.error);
    else {
      last = got.value;
      onValue(got.value);
      if (done(got.value)) return { outcome: 'done', value: got.value };
    }
    const remaining = start + maxMs - now();
    if (remaining <= 0) return { outcome: 'timeout', value: last };
    await Promise.race([sleep(Math.min(intervalMs, remaining)), stop]);
  }
}
