// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title ClaimRules
/// @notice The time and fee rules of a claim, in one place. StakeAttestation enforces them and
///         StakeAttestationLens reports them; both compile this library in, so the views can
///         never disagree with what the contract accepts.
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

    /// @notice The per-oracle fee a request is sent with: the listing's, clamped to the
    ///         aggregator's live ceiling (the aggregator clamps it itself; mirrored here so the
    ///         quote and the request agree), as BountyEscrow._effectiveOracle does.
    function effectiveFee(uint256 listingFee, uint256 ceiling) internal pure returns (uint256) {
        return listingFee > ceiling ? ceiling : listingFee;
    }
}
