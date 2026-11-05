// Loaded with `node --require` into one test's own process, before @verdikta/common: replaces common's
// production trusted-builder set with the one key in STUB_TRUSTED_KEY. No release holds the Verdikta key
// yet and no test holds its private half, so this is the only way a test can walk the production path
// past the trust check. It proves the builder's path, and says nothing about what common ships.
const file = require.resolve('@verdikta/common/src/codeReview/trustedBuilderKeys.js');
require(file);
require.cache[file].exports = [JSON.parse(process.env.STUB_TRUSTED_KEY)];
