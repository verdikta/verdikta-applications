const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** A host only this machine can reach: plain HTTP (and a bearer token over it) is allowed there. */
export function isLoopbackHost(hostname) {
  return LOOPBACK.has(hostname) || /^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(hostname);
}
