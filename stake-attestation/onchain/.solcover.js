// solidity-coverage (`npm run coverage`, `npm run coverage:check`). Only the production
// contracts are instrumented and measured: the mocks, the test harness and the interface are
// compiled as they are. json-summary feeds scripts/check-coverage.js, the 95% line gate.
// Tests tagged @skip-on-coverage read the contracts and change nothing of them (the launch smoke
// check, test/smoke.test.js): they add no line and cost the job's time, so coverage leaves them out.
module.exports = {
  skipFiles: ["mocks/", "test/", "interfaces/"],
  istanbulReporter: ["html", "lcov", "text", "json", "json-summary"],
  mocha: { grep: "@skip-on-coverage", invert: true },
};
