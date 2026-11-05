// Loaded with `node --require` into one test's own process, before @verdikta/common: replaces common's
// production trusted-builder set with the one key in STUB_TRUSTED_KEY. No test holds the private half of
// the Verdikta key, so this is the only way a test can walk the production path past the trust check.
const file = require.resolve('@verdikta/common/src/codeReview/trustedBuilderKeys.js');
require(file);
require.cache[file].exports = [JSON.parse(process.env.STUB_TRUSTED_KEY)];
