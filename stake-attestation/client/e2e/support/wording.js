// The wording guard (shared/src/wording.js): the unit tests run it over every UI string
// (src/strings.js), the Playwright tests over the text the record, feed and claim pages render,
// which includes what the server relays (labels, badge text, the control facts).
export { JUDGEMENTAL, wordingProblems } from '@verdikta/stake-attestation-shared';
