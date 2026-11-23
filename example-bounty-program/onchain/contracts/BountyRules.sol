// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";

/// @title BountyRules
/// @notice THE interpreter of an aggregator round for a bounty (verdikta-dispatcher TODO item 12),
///         compiled into both BountyEscrow and BountyEscrowLens so that payout, eligibility and the
///         lens's advice can never disagree about what a round means.
/// @dev The rule, with the bounty's threshold T (0..100), pass quota Q and forfeit line R (R <= Q):
///      each counted arbiter's FUND score is compared with T (scores are on 0..SCORE_SCALE, T on
///      0..100, so a score counts when score >= T x SCORE_DIVISOR):
///        Pass       at least Q scores at or above T
///        SoftFail   R to Q - 1 of them: the hunter may re-run, keeping its place and bond
///        HardFail   fewer than R: the bond goes to the creator
///        NoResult   the round ended, or must end, without a usable result: failed (phase 8),
///                   cancelled (9), past its deadline unsettled, never drawn within a day, or a
///                   corrupt result (an unexpected length, or an aggregated score above SCORE_SCALE).
///                   Not the hunter's fault: it may re-run, keeping place and bond.
///      FUND is outcome 1 of a two-outcome result [DONT_FUND, FUND], or outcome 0 of a one-number
///      result [FUND]. A score above SCORE_SCALE never counts (a corrupt value must not pass).
library BountyRules {
    uint256 internal constant SCORE_SCALE = 1_000_000;
    uint256 internal constant SCORE_DIVISOR = 10_000;

    // aggregator phases (IVerdiktaAggregator)
    uint8 internal constant PH_DRAW = 1;
    uint8 internal constant PH_BEACON = 2;
    uint8 internal constant PH_COMMIT = 3;
    uint8 internal constant PH_CLOSING = 4;
    uint8 internal constant PH_REVEAL = 5;
    uint8 internal constant PH_FINAL = 6;
    uint8 internal constant PH_SETTLED = 7;
    uint8 internal constant PH_FAILED = 8;
    uint8 internal constant PH_CANCELLED = 9;

    uint256 internal constant DRAW_GRACE = 1 days;   // the aggregator's: no draw later than this after the request

    enum Outcome { NotReady, NoResult, Pass, SoftFail, HardFail }

    struct Verdict {
        Outcome outcome;
        bool hasResult;      // the aggregator reported a result (NoResult with a result: a malformed one)
        uint256 passCount;   // scores at or above T
        uint256 acceptance;  // the aggregated FUND score, 0..100
        uint256 rejection;   // DONT_FUND (two outcomes) or 100 - acceptance (one number), 0..100
        string justificationCids;
    }

    /// @dev Read and judge round `aggId`. Never reverts on the round's content; reverts only if the
    ///      aggregator call itself does.
    function judge(IVerdiktaAggregator agg, bytes32 aggId, uint256 threshold, uint256 quota, uint256 forfeitLine)
        internal view returns (Verdict memory v)
    {
        (uint256[] memory aggregated, string memory cids, bool ok) = agg.getEvaluation(aggId);
        if (!ok) {
            // no result, and none can come: failed or cancelled, a drawn round past its deadline (settle
            // is due), or an undrawn one past the draw's 1-day limit (it can only be cancelled)
            (uint8 phase, , , , , , , , uint256 deadline, , , uint256 requestTime) = agg.getRoundInfo(aggId);
            bool dead = phase == PH_FAILED || phase == PH_CANCELLED ||
                (phase >= PH_COMMIT && phase <= PH_REVEAL && block.timestamp > deadline) ||
                (phase <= PH_BEACON && block.timestamp > requestTime + DRAW_GRACE);
            v.outcome = dead ? Outcome.NoResult : Outcome.NotReady;
            return v;
        }
        v.hasResult = true;
        v.justificationCids = cids;
        uint256 len = aggregated.length;
        if (len != 1 && len != 2) { v.outcome = Outcome.NoResult; return v; }
        for (uint256 i = 0; i < len; ++i) {
            if (aggregated[i] > SCORE_SCALE) { v.outcome = Outcome.NoResult; return v; }
        }
        uint256 fundIdx = len - 1;
        (uint256[] memory scores, bool valid) = agg.getOutcomeScores(aggId, fundIdx);
        if (!valid) { v.outcome = Outcome.NoResult; return v; }

        uint256 t = threshold * SCORE_DIVISOR;
        uint256 count;
        for (uint256 i = 0; i < scores.length; ) {
            uint256 s = scores[i];
            if (s >= t && s <= SCORE_SCALE) ++count;
            unchecked { ++i; }
        }
        v.passCount = count;
        v.acceptance = aggregated[fundIdx] / SCORE_DIVISOR;
        if (len == 2) {
            v.rejection = aggregated[0] / SCORE_DIVISOR;
        } else {
            v.rejection = 100 - v.acceptance;
        }
        if (count >= quota) v.outcome = Outcome.Pass;
        else if (count >= forfeitLine) v.outcome = Outcome.SoftFail;
        else v.outcome = Outcome.HardFail;
    }

    /// @dev True when the round has a result that passes (the start-time and lens sibling scans).
    function passes(IVerdiktaAggregator agg, bytes32 aggId, uint256 threshold, uint256 quota, uint256 forfeitLine)
        internal view returns (bool)
    {
        return judge(agg, aggId, threshold, quota, forfeitLine).outcome == Outcome.Pass;
    }
}
