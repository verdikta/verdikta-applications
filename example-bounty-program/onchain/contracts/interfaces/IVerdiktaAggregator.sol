// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVerdiktaAggregator (v2)
 * @notice What a requester uses of the v2 ReputationAggregator (verdikta-dispatcher, `beacon` branch,
 *         reputationBasedAggregator/contracts/ReputationAggregator.sol; MIGRATION.md lists the changes
 *         from v1). This file is kept byte-identical in example-bounty-program and stake-attestation.
 * @dev A round's life, by `getRoundInfo` phase:
 *        1 draw      escrowed by the request (block B); drawJury from B+2, within DRAW_GRACE (1 day)
 *        2 beacons   (requests with `withBeacons`) the first drawJury started the beacon stage; a second
 *                    drawJury draws once the beacon quorum is in, or ends the round if it was missed
 *        3 commit    jurors commit; the M+-th commit, or closeCommits after windowEnd with >= M, closes it
 *        4 closing   promote from closeBlock + 2
 *        5 reveal    the N-th counted reveal finalizes
 *        6 final     getEvaluation / getOutcomeScores valid; refund credited; settle after `deadline`
 *        7 settled   (from 6)
 *        8 failed    no result. The unspent prepay was credited to the requester (pool shortage, too few
 *                    commits or reveals); shared by the committed slots (CommitPayment, counted in the
 *                    round's rewards) when M commits were in but it was never promoted; or credited to
 *                    the arbiter pool (beacon quorum missed; a beacon round whose jury can't be drawn
 *                    when the walk is partial; the committers' indivisible remainder)
 *        9 cancelled never drawn: cancelUnsealed credits the whole prepay to the arbiter pool
 *      The arbiter pool is the ledger entry ethOwed(address(0)), which nobody can withdraw: a credit
 *      to it is announced as RequesterRefunded(aggId, address(0), amount), or as RoundCancelled. Each
 *      draw pays an eighth of it to one random registered arbiter's payee (PoolPayment). There is no
 *      treasury in v2.
 *      An undrawn round never times out. Ids are sequential from 1: aggId = bytes32(roundId).
 *      Refunds and rewards are credited to ethOwed and pulled with withdrawEth.
 */
interface IVerdiktaAggregator {
    /// @notice The jury a request asks for (ReputationAggregator.Jury; item 15's class presets): K drawn,
    ///         M promoted, N counted, P clustered, and the round timeout (seconds, from the draw). One
    ///         aggregator serves every class. The request reverts BadJury (AggregatorLib) unless
    ///         K >= M >= N >= P >= 1, N <= 40, P >= 2 unless N = 1, K <= maxJury() and the keeper's
    ///         shortlistSize(), and tPlus() < timeout <= maxTimeout().
    struct Jury {
        uint8 K;
        uint8 M;
        uint8 N;
        uint8 P;
        uint40 timeout;
    }

    /**
     * @notice Request an evaluation, funded in ETH. Escrows maxTotalFee(maxFee, minFee, withBeacons, K, P):
     *         msg.value first, then the caller's ethOwed credit for any shortfall; any excess value goes
     *         to credit. The jury is drawn later by drawJury.
     * @param cids             IPFS CIDs (1..10, each <= 100 bytes)
     * @param addendumText     appended to the query (<= 1000 bytes)
     * @param alpha            0..1000, quality-vs-timeliness blend in arbiter selection
     * @param maxFee           per-arbiter fee ceiling in wei (clamped to maxOracleFee); eligibility
     * @param minFee           fee floor in wei (0 = none): every juror and beacon is paid at least this
     * @param estimatedBaseCost  < the clamped ceiling; price-boost baseline
     * @param maxFeeBasedScalingFactor  1..65535, caps the price boost
     * @param requestedClass   ClassID (the model pool)
     * @param withBeacons      item 9's beacon flag
     * @param jury             the round's jury and timeout (see Jury)
     */
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 alpha,
        uint256 maxFee,
        uint256 minFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass,
        bool withBeacons,
        Jury calldata jury
    ) external payable returns (bytes32 aggId);

    /// @notice The escrow for one request with a jury of K drawn and P clustered:
    ///         max(eff, minFee) x (K + B x P [+ beacon quorum]) + eff x (drawRewardFees + promoteRewardFees),
    ///         eff = min(maxFee, maxOracleFee). Reverts with `withBeacons` when no beacon contract is set.
    function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons, uint8 K, uint8 P)
        external view returns (uint256);

    /// @notice Draw the jury (anyone, from block B+2). The drawer earns 2 x eff: only the requester
    ///         within 30 s of the request (or of the beacon quorum), anyone after. With beacons the first
    ///         call starts the beacon stage and a second draws.
    function drawJury(bytes32 aggId) external;

    /// @notice Store blockhash(B+1) while it is readable (anyone; drawJury does it too).
    function sealSeed(bytes32 aggId) external;

    /// @notice Close the commit phase after windowEnd with at least M commits (anyone).
    function closeCommits(bytes32 aggId) external;

    /// @notice Draw the M promoted commits (anyone, from closeBlock + 2). The caller earns 1 x eff.
    function promote(bytes32 aggId) external;

    /// @notice After the deadline: fail the round if it never finished, and report to the keeper (anyone).
    function settle(bytes32 aggId) external;

    /// @notice A round that can never be drawn: its prepay goes to the arbiter pool (anyone, once unsealed
    ///         past the block-hash history, or sealed and undrawn for DRAW_GRACE).
    function cancelUnsealed(bytes32 aggId) external;

    /// @notice The aggregated scores and the comma-joined justification CIDs. `valid` from phase 6.
    function getEvaluation(bytes32 aggId)
        external
        view
        returns (uint256[] memory aggregated, string memory justifications, bool valid);

    /// @notice Every counted reveal's score for `outcome`, in reveal order (a short reveal gives 0).
    ///         `valid` is false before phase 6, for a failed round, and for an outcome past the result.
    function getOutcomeScores(bytes32 aggId, uint256 outcome)
        external
        view
        returns (uint256[] memory scores, bool valid);

    /// @notice The round's phase (see above), draw blocks, escrow and timing. `deadline` is 0 until the
    ///         draw; settle is due after it. Received minus the three credited amounts is refunded.
    function getRoundInfo(bytes32 aggId)
        external
        view
        returns (
            uint8 phase,
            uint256 requestBlock,
            bytes32 sealedHash,
            uint256 closeBlock,
            uint256 received,
            uint256 baseFees,
            uint256 bonuses,
            uint256 rewards,
            uint256 deadline,
            uint256 windowEnd,
            uint256 commits,
            uint256 requestTime
        );

    /// @notice The jury a round was requested with (zeros for an unknown round).
    function getJury(bytes32 aggId) external view returns (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout);

    function isFailed(bytes32 aggId) external view returns (bool);

    /// @notice ETH (wei) credited to `account`: refunds, rewards and payments.
    function ethOwed(address account) external view returns (uint256);

    /// @notice Withdraw the caller's whole ethOwed balance.
    function withdrawEth() external;

    /// @notice The per-arbiter fee ceiling every request is clamped to.
    function maxOracleFee() external view returns (uint256);

    /// @notice The largest K a request may ask for (owner-set; the keeper's shortlist also bounds it).
    function maxJury() external view returns (uint8);

    /// @notice The longest round timeout a request may ask for (owner-set).
    function maxTimeout() external view returns (uint40);

    /// @notice The beacon contract (address(0): requests with withBeacons revert).
    function beacons() external view returns (address);

    event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids);
    event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue);
    event SeedSealed(bytes32 indexed aggRequestId, bytes32 blockHash);
    event BeaconStageStarted(bytes32 indexed aggRequestId, uint256 beacons);
    event JuryDrawn(bytes32 indexed aggRequestId, address indexed drawer, uint256 reward);
    event CommitWindowClosed(bytes32 indexed aggRequestId, uint256 closeBlock);
    event CommitPhaseComplete(bytes32 indexed aggRequestId, uint256 promoted);
    event FulfillAIEvaluation(bytes32 indexed aggRequestId, uint256[] aggregated, string justifications);
    event EvaluationFailed(bytes32 indexed aggRequestId, uint8 phase);
    event RoundSettled(bytes32 indexed aggRequestId, bool failed);
    /// @notice A never-drawn round cancelled: its whole prepay (`toPool`) went to the arbiter pool
    event RoundCancelled(bytes32 indexed aggRequestId, uint256 toPool);
    /// @dev requester = address(0): a credit to the arbiter pool, not a refund
    event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount);
    /// @notice A never-promoted round's unspent prepay, an equal share per committed slot
    event CommitPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
    /// @notice An eighth of the arbiter pool, paid at a draw to a random registered arbiter's payee
    event PoolPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
    event EthWithdrawn(address indexed payee, uint256 amount);
}
