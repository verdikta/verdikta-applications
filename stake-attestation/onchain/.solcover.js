// solidity-coverage (`npm run coverage`, `npm run coverage:check`). Only the production
// contracts are instrumented and measured: the mocks, the test harness and the interface are
// compiled as they are. json-summary feeds scripts/check-coverage.js, the 95% line gate.
module.exports = {
  skipFiles: ["mocks/", "test/", "interfaces/"],
  istanbulReporter: ["html", "lcov", "text", "json", "json-summary"],
};
