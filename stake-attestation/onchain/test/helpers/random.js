// A deterministic PRNG (mulberry32) for the randomized tests, so a failure reproduces from its
// seed, and a helper that splits a total into random non-negative parts.

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // inclusive
  const pick = (xs) => xs[int(0, xs.length - 1)];
  return { next, int, pick };
}

// `total` split into `n` non-negative integer parts at random cut points.
function split(r, total, n) {
  const cuts = Array.from({ length: n - 1 }, () => r.int(0, total)).sort((x, y) => x - y);
  const parts = [];
  let prev = 0;
  for (const c of cuts) {
    parts.push(c - prev);
    prev = c;
  }
  parts.push(total - prev);
  return parts;
}

module.exports = { rng, split };
