// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title ClaimRules
/// @notice The time, fee and settlement rules of a claim, in one place. StakeAttestation
///         enforces them and StakeAttestationLens reports them; both compile this library in, so
///         the views can never disagree with what the contract accepts.
/// @dev Windows are half-open: a window [start, start + length) is open while
///      block.timestamp < start + length and over from start + length on.
library ClaimRules {
    /// @notice "Never": the revealable time of a claim that has not disclosed.
    uint256 internal constant NEVER = type(uint256).max;

    /// @notice Program constants (StakeAttestation re-exports each as a public constant, where
    ///         they are documented): erratum E5's disclose window, erratum E2's cap on prior
    ///         findings per request, the gas every request is sent with, and the gas a reveal
    ///         must hold before sending it.
    uint256 internal constant DISCLOSE_WINDOW = 1 hours;
    uint256 internal constant MAX_PRIOR_FINDINGS = 8;
    uint256 internal constant SUBMISSION_GAS = 10_000_000;
    /// @dev SUBMISSION_GAS reaches the callee only if the CALL has SUBMISSION_GAS * 64 / 63
    ///      available (EIP-150); the extra 100k pays for encoding the arguments, the CALL itself
    ///      and finishing either branch afterwards.
    uint256 internal constant SUBMISSION_GAS_NEEDED = SUBMISSION_GAS + SUBMISSION_GAS / 63 + 100_000;

    /// @notice Settlement (design §8.7): the jury's vector over [INVALID, DUPLICATE, LOW, MEDIUM,
    ///         HIGH, CRITICAL] sums to SCORE_SCALE, less the aggregator's flooring loss (it
    ///         averages the clustered reveals with integer division, losing under one unit on
    ///         each of six components: at most 5, erratum E4), so MIN_SCORE_SUM..SCORE_SCALE is
    ///         a verdict. THRESHOLD is a strict majority (T = 500,001). The same numbers as the
    ///         common package's OUTCOME_MASS_TOTAL, OUTCOME_MASS_MIN_TOTAL and
    ///         DEFAULT_SETTLEMENT_THRESHOLD; the tests hold them equal.
    uint256 internal constant SCORE_SCALE = 1_000_000;
    uint256 internal constant MIN_SCORE_SUM = SCORE_SCALE - 5;
    uint256 internal constant THRESHOLD = 500_001;
    uint256 internal constant OUTCOMES = 6;
    uint8 internal constant INVALID = 0;
    uint8 internal constant DUPLICATE = 1;
    uint8 internal constant LOW = 2;

    /// @notice Gas for the inline recovery of a round's unspent prepay (the wallet pulls its
    ///         ethOwed and hands it back), as BountyEscrow's INLINE_REFUND_GAS_LIMIT.
    uint256 internal constant INLINE_REFUND_GAS_LIMIT = 200_000;
    /// @dev What finalize must hold before the recovery, so the wallet always gets the whole
    ///      INLINE_REFUND_GAS_LIMIT (EIP-150 keeps 1/64 back) and finishing after it is paid for:
    ///      whether the recovery is deferred then depends on the aggregator, never on the gas
    ///      limit a caller picks.
    uint256 internal constant INLINE_REFUND_GAS_NEEDED = INLINE_REFUND_GAS_LIMIT + INLINE_REFUND_GAS_LIMIT / 63 + 30_000;

    /// @notice When a claim's fix window ends (design §7.1, erratum E5).
    /// @param disclosedAt        0 while undisclosed (then NEVER)
    /// @param fixWindowEnd       disclosedAt + fixWindow, or the release time if the maker released it
    /// @param disclosedAfterRoll the claim disclosed after its listing rolled forward
    /// @param rolledAt           when the listing rolled forward (0 = it has not)
    /// @return the earliest of the claim's own window end and, for a claim disclosed before
    ///         the roll-forward, the roll-forward itself: rollForward ends the window of every
    ///         disclosed claim at once without touching them (no loop over claims). A claim
    ///         disclosed after it gets its own window, since the maker has not yet seen it.
    function revealableAt(uint64 disclosedAt, uint64 fixWindowEnd, bool disclosedAfterRoll, uint64 rolledAt)
        internal pure returns (uint256)
    {
        if (disclosedAt == 0) return NEVER;
        if (rolledAt != 0 && !disclosedAfterRoll && rolledAt < fixWindowEnd) return rolledAt;
        return fixWindowEnd;
    }

    /// @notice Decision D5: the reveal clock of the claim at the head of commit order starts at
    ///         max(revealableAt, headSince), headSince being when every earlier claim had
    ///         resolved; the claim may be revealed until, and expired from, the returned time.
    function revealDeadline(uint256 revealable, uint64 headSince, uint32 revealWindow)
        internal pure returns (uint256)
    {
        return (revealable > headSince ? revealable : headSince) + revealWindow;
    }

    /// @notice Erratum E6: the hunter may re-trigger a failed round until, and anyone may expire
    ///         it from, revealWindow after the claim FIRST entered RoundFailed (failedAt is set
    ///         once): a re-triggered round that fails again does not extend the window. §12 puts
    ///         the re-trigger "inside the reveal window"; measured from the failure, because a
    ///         round can fail after the reveal deadline it was sent before.
    function retriggerDeadline(uint64 failedAt, uint32 revealWindow) internal pure returns (uint256) {
        return uint256(failedAt) + revealWindow;
    }

    /// @notice The per-oracle fee a request is sent with: the listing's, clamped to the
    ///         aggregator's live ceiling (the aggregator clamps it itself; mirrored here so the
    ///         quote and the request agree), as BountyEscrow._effectiveOracle does.
    function effectiveFee(uint256 listingFee, uint256 ceiling) internal pure returns (uint256) {
        return listingFee > ceiling ? ceiling : listingFee;
    }

    /// @notice The outcome of a jury vector (design §8.7, decisions 10 and 11), as the common
    ///         package's settleBugOutcome decides it (the differential test holds them equal).
    ///         1. Valid when the mass on LOW..CRITICAL together is at least THRESHOLD; the class
    ///            is then the highest class whose mass at or above it reaches THRESHOLD (the
    ///            median class, T being a majority). Both in one pass from CRITICAL down: the
    ///            first class at which the running mass reaches T is the class, and if the
    ///            running mass never reaches it the valid mass is below T.
    ///         2. Otherwise DUPLICATE when its mass is at least INVALID's, else INVALID.
    /// @return wellFormed false for a vector that is no verdict: a length other than OUTCOMES, a
    ///         component above SCORE_SCALE, or a sum outside MIN_SCORE_SUM..SCORE_SCALE (a failed
    ///         round, never a revert; the component check comes first so the sum cannot wrap)
    /// @return outcome    the index into the outcome order (0 when not wellFormed)
    function judge(uint256[] memory v) internal pure returns (bool wellFormed, uint8 outcome) {
        if (v.length != OUTCOMES) return (false, 0);
        uint256 sum;
        for (uint256 i = 0; i < OUTCOMES; ) {
            uint256 x = v[i];
            if (x > SCORE_SCALE) return (false, 0);
            sum += x; // at most 6 * SCORE_SCALE
            unchecked { ++i; }
        }
        if (sum < MIN_SCORE_SUM || sum > SCORE_SCALE) return (false, 0);
        uint256 mass; // at or above class i
        for (uint256 i = OUTCOMES; i > LOW; ) {
            unchecked { --i; }
            mass += v[i];
            if (mass >= THRESHOLD) return (true, uint8(i));
        }
        return (true, v[DUPLICATE] >= v[INVALID] ? DUPLICATE : INVALID);
    }

    /// @notice What a settled outcome pays: awards[class] for a class at or above the listing's
    ///         lowestClassCounted, else nothing (DUPLICATE and INVALID included).
    /// @param awards        the listing's table, by class: [LOW, MEDIUM, HIGH, CRITICAL]
    /// @param lowestCounted the listing's lowestClassCounted, as an outcome index (LOW..CRITICAL)
    function awardFor(uint256[4] memory awards, uint8 lowestCounted, uint8 outcome) internal pure returns (uint256) {
        if (outcome < LOW || outcome < lowestCounted) return 0;
        return awards[outcome - LOW];
    }
}
