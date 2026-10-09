'use strict';
const fs = require('fs');
const { address, digest } = require('./config');
function emptyExceptions() {
  return {
    denyBounties: {},
    holdWallets: {},
    identityReleases: [],
  };
}
function validateExceptions(input, deployment) {
  const result = emptyExceptions();
  const validReview = (review) =>
    review &&
    typeof review === 'object' &&
    ['reviewer', 'reason'].every(
      (field) =>
        typeof review[field] === 'string' &&
        review[field].trim().length > 0 &&
        review[field].length <= 2000,
    ) &&
    typeof review.reviewedAt === 'string' &&
    /Z$/.test(review.reviewedAt) &&
    Number.isFinite(Date.parse(review.reviewedAt));
  try {
    if (
      !input ||
      Object.keys(input).some((field) => !Object.hasOwn(result, field))
    )
      throw new Error();
    for (const field of ['denyBounties', 'holdWallets']) {
      if (
        !input[field] ||
        typeof input[field] !== 'object' ||
        Array.isArray(input[field])
      )
        throw new Error();
      for (const [entryKey, review] of Object.entries(input[field])) {
        if (!validReview(review)) throw new Error();
        if (field === 'holdWallets') {
          if (address(entryKey) !== entryKey) throw new Error();
        } else if (
          !entryKey.startsWith(`8453:${deployment.address}:`) ||
          !/^8453:0x[0-9a-f]{40}:[0-9]+$/.test(entryKey)
        ) {
          throw new Error();
        }
        result[field][entryKey] = review;
      }
    }
    if (!Array.isArray(input.identityReleases)) throw new Error();
    for (const release of input.identityReleases) {
      if (
        !validReview(release) ||
        !/^[a-f0-9]{64}$/.test(release.userHash) ||
        address(release.wallet) !== release.wallet
      )
        throw new Error();
      result.identityReleases.push(release);
    }
    return result;
  } catch {
    throw new Error('EXCEPTIONS_FILE_INVALID');
  }
}
function readExceptions(filename, deployment) {
  try {
    if (fs.statSync(filename).size > 1024 * 1024) throw new Error();
    return validateExceptions(
      JSON.parse(fs.readFileSync(filename, 'utf8')),
      deployment,
    );
  } catch {
    throw new Error('EXCEPTIONS_FILE_INVALID');
  }
}
function applyIdentityReleases(store, releases) {
  store.transactClaims((state) => {
    for (const release of releases) {
      const releaseId = digest(release);
      if (state.appliedReleases[releaseId]) continue;
      if (
        state.identities[release.userHash] === release.wallet &&
        state.wallets[release.wallet] === release.userHash
      ) {
        delete state.identities[release.userHash];
        delete state.wallets[release.wallet];
      }
      // Consume a reviewed release once; leaving it in the file must not erase a new binding each cycle.
      state.appliedReleases[releaseId] = release;
    }
  });
}
module.exports = {
  emptyExceptions,
  validateExceptions,
  readExceptions,
  applyIdentityReleases,
};
