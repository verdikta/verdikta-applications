// Mutual wager terms: build, mirror and check the MUTUAL WAGER TERMS block of a wager bounty
// (mutual-wager-v3 for a game, mutual-wager-v5 for a question; v4 questions are still read).
// The implementation is shared with the bounty server (shared/mutualWager.js, plain CommonJS):
// the server's /api/wagers endpoints and its POST /api/jobs/create check run the same code as
// this page, so a wager the page accepts is one the server accepts. vite.config.js serves the
// shared module to the browser as an ES module.
//
// The create page runs checkMutualWagerTerms before funding, and checkCounterBounty when the
// terms name a counter bounty: the jury skips its own counter checks in that case, so the
// site checks the named bounty's live record instead.
export {
  MUTUAL_WAGER_RUBRIC,
  MUTUAL_WAGER_CRITERIA,
  MUTUAL_WAGER_TERMS_HEADER,
  MUTUAL_WAGER_TEMPLATE,
  QUESTION_WAGER_RUBRIC,
  QUESTION_WAGER_CRITERIA,
  QUESTION_WAGER_TEMPLATE,
  MIN_START_LEAD_SECONDS,
  mutualWagerTemplate,
  mutualWagerRubricJson,
  formatJury,
  formatOracle,
  wagerChainLabel,
  buildMutualWagerBounty,
  mutualWagerTermsSkeleton,
  questionWagerTermsSkeleton,
  hasMutualWagerTerms,
  parseMutualWagerTerms,
  canonicalWagerText,
  looksLikeMutualWager,
  checkMutualWagerTerms,
  checkCounterBounty,
  findWagerTwin,
  mirrorMutualWagerTerms,
} from '../../../shared/mutualWager.js';
