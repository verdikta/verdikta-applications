// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IVerdiktaAggregator} from "../interfaces/IVerdiktaAggregator.sol";

/// @title MockVerdiktaAggregator (v2)
/// @notice Test double for the v2 ReputationAggregator (verdikta-dispatcher, `beacon` branch). It
///         reproduces what a requester can observe, with the real numbers, and nothing more:
///         - Poll-only: the aggregator never calls the requester. There is no receive().
///         - The request escrows maxTotalFee(maxFee, minFee, withBeacons) by the real formula,
///           max(eff, minFee) x (K + B x P [+ quorum]) + eff x (drawRewardFees + promoteRewardFees):
///           msg.value first, then credit for any shortfall, any excess value to credit.
///         - Sequential ids from 1, the same input limits (BadInput), pause gate, errors and events.
///         - The phases: draw from block B+2 within a day, the beacon stage, commits closing at M+
///           (or closeCommits after T+ with >= M), promote from C+2, finalization at the N-th reveal,
///           settle after the deadline (which runs from the draw), cancelUnsealed for an undrawable
///           round. Base fees are credited at the draw, bonuses at finalization, rewards to whoever
///           draws (the requester only within 30 s) and promotes. Refunds go to the requester, or to
///           the treasury where the real contract sends them (beacon quorum missed, M commits but
///           never promoted, cancelled).
/// @dev Test hooks stand in for the arbiters and the owner:
///         arbiters: scriptCommits, scriptReveals, scriptResult (a shortcut from any drawn phase),
///                   scriptBeacons, setPoolShortage;
///         owner:    setConfig, setTimeouts, setRewards, setBonusMultiplier, setMaxOracleFee,
///                   setArbiterFee (the jurors' posted fee; 0 = the ceiling), setTreasury,
///                   setBeacons, setPaused;
///         faults:   setRequestGasCost, setWithdrawBroken, setWithdrawBurnsGas.
///      Base fees, bonuses and beacon payments are credited to ARBITERS, a stand-in payee.
///      This file is kept byte-identical in example-bounty-program and stake-attestation.
contract MockVerdiktaAggregator is IVerdiktaAggregator, ReentrancyGuard, Pausable {
    // ---- the real contract's limits ----
    uint256 public constant MAX_CID_COUNT = 10;
    uint256 public constant MAX_CID_LENGTH = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;
    uint256 public constant MAX_LIKELIHOOD_LENGTH = 20;
    uint256 public constant HISTORY_WINDOW = 8191;
    uint40 public constant DRAW_GRACE = 1 days;
    uint40 public constant PROMOTE_GRACE = 30;
    address public constant ARBITERS = address(0xA4B17E45);

    uint8 private constant PH_DRAW = 1;
    uint8 private constant PH_BEACON = 2;
    uint8 private constant PH_COMMIT = 3;
    uint8 private constant PH_CLOSING = 4;
    uint8 private constant PH_REVEAL = 5;
    uint8 private constant PH_FINAL = 6;
    uint8 private constant PH_SETTLED = 7;
    uint8 private constant PH_FAILED = 8;
    uint8 private constant PH_CANCELLED = 9;

    // ---- the real contract's errors ----
    error BadInput();
    error InsufficientPayment();
    error WrongPhase();
    error TooEarly();
    error NotDue();
    error SeedExpired();
    error DrawExpired();
    error NothingOwed();
    error EthTransferFailed();
    /// @dev Mock-only: a scripted outcome no real round could produce.
    error Unreachable();

    // ---- the real contract's other events ----
    event BeaconPayment(bytes32 indexed aggRequestId, address indexed payee, uint256 amount);
    event BasePayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
    event BonusPayment(bytes32 indexed aggRequestId, uint256 pollIndex, address indexed payee, uint256 amount);
    event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bytes32 commitHash);
    event RevealReceived(bytes32 indexed aggRequestId, uint256 pollIndex, bool late, uint8 qcode);

    // ---- configuration (owner-set on the real contract) ----
    uint8 public override K = 6;
    uint8 public override M = 5;
    uint8 public override N = 4;
    uint8 public override P = 3;
    uint8 public bonusMultiplier = 3;
    uint8 public drawRewardFees = 2;
    uint8 public promoteRewardFees = 1;
    uint40 public requesterDrawPriority = 30;
    uint40 public override responseTimeoutSeconds = 300;
    uint40 public tPlus = 155;
    uint40 public revealWindow = 120;
    uint256 public override maxOracleFee = 4e14;
    address public treasury = address(0x7EA5);
    uint8 public beaconQuorum = 2;
    bool public beaconsEnabled = true;

    // ---- test controls ----
    uint256 public arbiterFee;              // the jurors' posted fee (0 = the ceiling)
    bool public poolShortage;               // the next draws find too few eligible arbiters
    uint256 public requestGasCost;
    bool public withdrawBroken;
    bool public withdrawBurnsGas;

    mapping(address => uint256) public override ethOwed;
    uint256 public roundCount;

    struct Round {
        address requester;
        uint8 phase;
        uint8 commits;
        uint8 k;
        uint8 m;
        uint8 n;
        uint8 p;
        uint8 bonusMult;
        uint8 drawFees;
        uint8 promoteFees;
        uint8 beaconFees;          // the quorum, fixed at request; 0 = no beacons
        uint8 beaconAnswers;       // scripted: beacon values in (stage ready at >= quorum)
        bool beaconsDone;          // scripted: the beacon deadline has passed
        uint32 requestBlock;
        uint32 closeBlock;
        uint40 requestTime;
        uint40 anchor;             // the draw's 30 s priority runs from here
        uint40 windowEnd;
        uint40 deadline;
        bytes32 sealedHash;
        uint256 eff;
        uint256 minFee;
        uint256 received;
        uint256 baseFees;
        uint256 bonuses;
        uint256 rewards;
        uint256[] aggregated;
        uint256 revealCount;
        string justifications;
        mapping(uint256 => uint256[]) reveals;
    }
    mapping(uint256 => Round) private _rounds;

    /// @dev What the requester forwarded, so tests can assert the request composition.
    struct RequestParams {
        string addendum;
        uint256 alpha;
        uint256 maxFee;
        uint256 minFee;
        uint256 estimatedBaseCost;
        uint256 maxFeeBasedScaling;
        uint64 requestedClass;
        bool withBeacons;
    }
    mapping(bytes32 => RequestParams) public requestParams;
    mapping(bytes32 => string[]) private _requestCids;

    // ------------------------------------------------------------------
    //                         owner stand-ins
    // ------------------------------------------------------------------

    function setConfig(uint8 k, uint8 m, uint8 n, uint8 p) external {
        if (k == 0 || m == 0 || n == 0 || p == 0 || m > k || n > m || p > n) revert BadInput();
        (K, M, N, P) = (k, m, n, p);
    }
    function setTimeouts(uint40 timeout, uint40 tPlus_, uint40 revealWindow_) external {
        (responseTimeoutSeconds, tPlus, revealWindow) = (timeout, tPlus_, revealWindow_);
    }
    function setRewards(uint8 drawFees_, uint8 promoteFees_) external {
        (drawRewardFees, promoteRewardFees) = (drawFees_, promoteFees_);
    }
    function setBonusMultiplier(uint8 b) external { bonusMultiplier = b; }
    function setMaxOracleFee(uint256 fee) external { maxOracleFee = fee; }
    function setArbiterFee(uint256 fee) external { arbiterFee = fee; }
    function setTreasury(address t) external { treasury = t; }
    function setBeacons(bool enabled, uint8 quorum) external { (beaconsEnabled, beaconQuorum) = (enabled, quorum); }
    function setPoolShortage(bool v) external { poolShortage = v; }
    function setRequestGasCost(uint256 gasAmount) external { requestGasCost = gasAmount; }
    function setWithdrawBroken(bool v) external { withdrawBroken = v; }
    function setWithdrawBurnsGas(bool v) external { withdrawBurnsGas = v; }
    function setPaused(bool p) external {
        if (p) _pause();
        else _unpause();
    }

    // ------------------------------------------------------------------
    //                         arbiter stand-ins
    // ------------------------------------------------------------------

    /// @notice `answered` beacon values arrive; `deadlinePassed` ends the stage (a miss below quorum).
    function scriptBeacons(bytes32 aggId, uint8 answered, bool deadlinePassed) external {
        Round storage r = _round(aggId);
        if (r.phase != PH_BEACON) revert WrongPhase();
        r.beaconAnswers = answered;
        r.beaconsDone = deadlinePassed;
        if (answered >= r.beaconFees) r.anchor = uint40(block.timestamp);   // the quorum-th value's time
    }

    /// @notice `count` more commits arrive (the M+-th closes the commit phase, as in fulfill).
    function scriptCommits(bytes32 aggId, uint8 count) external {
        Round storage r = _round(aggId);
        if (r.phase != PH_COMMIT || block.timestamp > r.deadline) revert WrongPhase();
        uint256 c = uint256(r.commits) + count;
        if (c > r.k) revert Unreachable();
        r.commits = uint8(c);
        for (uint256 i = 0; i < count; i++) emit CommitReceived(aggId, c - count + i, bytes32(c - count + i + 1));
        uint256 mPlus = uint256(r.m) + (uint256(r.k) - r.m + 1) / 2;
        if (c >= mPlus || (block.timestamp > r.windowEnd && c >= r.m)) _closeWindow(r, aggId);
    }

    /// @notice The N counted reveals arrive (phase 5): the round finalizes on the cluster mean, which
    ///         the mock takes as the mean of all reveals. Reveals may differ in length, as on the real
    ///         aggregator: the result has the most common length (ties: the shorter), each reveal resized
    ///         to it for the mean (truncated, or zero-filled), while getOutcomeScores returns each reveal
    ///         as sent (0 for an outcome a short reveal lacks).
    function scriptReveals(bytes32 aggId, uint256[][] calldata reveals, string calldata justifications) external {
        Round storage r = _round(aggId);
        if (r.phase != PH_REVEAL || block.timestamp > r.deadline) revert WrongPhase();
        if (reveals.length != r.n) revert Unreachable();
        _finalizeWith(r, aggId, reveals, justifications);
    }

    /// @notice Shortcut: from any drawn phase before final, N identical reveals of `aggregated`
    ///         (commits and promotion are skipped; nobody earns the promote reward). Not after the
    ///         round's deadline: there the real aggregator only settles the round, as failed.
    function scriptResult(bytes32 aggId, uint256[] calldata aggregated, string calldata justifications) external {
        Round storage r = _round(aggId);
        if (r.phase < PH_COMMIT || r.phase > PH_REVEAL || block.timestamp > r.deadline) revert WrongPhase();
        uint256[][] memory reveals = new uint256[][](r.n);
        for (uint256 i = 0; i < r.n; i++) reveals[i] = aggregated;
        if (r.commits < r.m) r.commits = r.m;
        r.phase = PH_REVEAL;
        _finalizeWith(r, aggId, reveals, justifications);
    }

    // ------------------------------------------------------------------
    //                    IVerdiktaAggregator
    // ------------------------------------------------------------------

    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 alpha,
        uint256 maxFee,
        uint256 minFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScalingFactor,
        uint64 requestedClass,
        bool withBeacons
    ) external payable override nonReentrant whenNotPaused returns (bytes32 aggId) {
        _burnGas(requestGasCost);
        if (cids.length == 0 || cids.length > MAX_CID_COUNT || bytes(addendumText).length > MAX_ADDENDUM_LENGTH)
            revert BadInput();
        for (uint256 i = 0; i < cids.length; i++) if (bytes(cids[i]).length > MAX_CID_LENGTH) revert BadInput();

        uint256 eff = maxFee < maxOracleFee ? maxFee : maxOracleFee;
        if (estimatedBaseCost >= eff || alpha > 1000 || maxFeeBasedScalingFactor < 1 || maxFeeBasedScalingFactor > type(uint16).max)
            revert BadInput();
        uint256 required = maxTotalFee(maxFee, minFee, withBeacons);
        if (required > type(uint88).max) revert BadInput();
        uint256 fromCredit = msg.value < required ? required - msg.value : 0;
        uint256 credit = ethOwed[msg.sender];
        if (credit < fromCredit) revert InsufficientPayment();
        ethOwed[msg.sender] = credit - fromCredit + (msg.value + fromCredit - required);

        uint256 id = ++roundCount;
        aggId = bytes32(id);
        Round storage r = _rounds[id];
        r.requester = msg.sender;
        r.phase = PH_DRAW;
        (r.k, r.m, r.n, r.p) = (K, M, N, P);
        r.bonusMult = bonusMultiplier;
        r.drawFees = drawRewardFees;
        r.promoteFees = promoteRewardFees;
        if (withBeacons) r.beaconFees = beaconQuorum;
        r.requestBlock = uint32(block.number);
        r.requestTime = uint40(block.timestamp);
        r.anchor = uint40(block.timestamp);
        r.eff = eff;
        r.minFee = minFee;
        r.received = required;
        requestParams[aggId] = RequestParams(
            addendumText, alpha, maxFee, minFee, estimatedBaseCost, maxFeeBasedScalingFactor, requestedClass, withBeacons
        );
        _requestCids[aggId] = cids;
        emit RequestFunded(aggId, msg.sender, fromCredit, msg.value);
        emit RequestAIEvaluation(aggId, cids);
    }

    function maxTotalFee(uint256 maxFee, uint256 minFee, bool withBeacons) public view override returns (uint256) {
        uint256 eff = maxFee < maxOracleFee ? maxFee : maxOracleFee;
        uint256 juror = minFee > eff ? minFee : eff;
        uint256 n = uint256(K) + uint256(bonusMultiplier) * P;
        if (withBeacons) {
            if (!beaconsEnabled) revert();   // the real call to beacons.quorum() on address(0)
            n += beaconQuorum;
        }
        return juror * n + eff * (uint256(drawRewardFees) + promoteRewardFees);
    }

    function sealSeed(bytes32 aggId) external override {
        Round storage r = _round(aggId);
        if (r.phase != PH_DRAW || r.sealedHash != bytes32(0)) revert WrongPhase();
        _seal(r);
    }

    function drawJury(bytes32 aggId) external override nonReentrant {
        Round storage r = _round(aggId);
        if (r.phase != PH_DRAW && r.phase != PH_BEACON) revert WrongPhase();
        if (block.timestamp > uint256(r.requestTime) + DRAW_GRACE) revert DrawExpired();
        uint256 pay = r.minFee > r.eff ? r.minFee : r.eff;
        if (r.phase == PH_DRAW) {
            if (r.sealedHash == bytes32(0)) _seal(r);
            if (r.beaconFees != 0) {
                if (poolShortage) {                       // fewer beacon candidates than the quorum: refund
                    r.phase = PH_FAILED;
                    _refund(r, aggId, r.requester);
                    emit EvaluationFailed(aggId, PH_DRAW);
                } else {
                    r.phase = PH_BEACON;
                    emit BeaconStageStarted(aggId, r.beaconFees * 2);
                }
                return;
            }
        } else {
            bool ready = r.beaconAnswers >= r.beaconFees;
            if (!ready && !r.beaconsDone) revert TooEarly();
            uint256 paid = ready ? r.beaconFees : r.beaconAnswers;
            for (uint256 i = 0; i < paid; i++) emit BeaconPayment(aggId, ARBITERS, pay);
            ethOwed[ARBITERS] += pay * paid;
            r.rewards += pay * paid;
            if (!ready) {                                 // quorum missed: no result, prepay to the treasury
                r.phase = PH_FAILED;
                _refund(r, aggId, treasury);
                emit EvaluationFailed(aggId, PH_BEACON);
                return;
            }
        }
        if (poolShortage) {                               // no eligible jury as of B: refund
            r.phase = PH_FAILED;
            _refund(r, aggId, r.requester);
            emit EvaluationFailed(aggId, PH_DRAW);
            return;
        }
        uint256 posted = arbiterFee != 0 && arbiterFee < r.eff ? arbiterFee : r.eff;
        uint256 juror = posted < r.minFee ? r.minFee : posted;
        r.phase = PH_COMMIT;
        r.windowEnd = uint40(block.timestamp) + tPlus;
        r.deadline = uint40(block.timestamp) + responseTimeoutSeconds;
        for (uint256 i = 0; i < r.k; i++) emit BasePayment(aggId, i, ARBITERS, juror);
        ethOwed[ARBITERS] += juror * r.k;
        r.baseFees = juror * r.k;
        uint256 reward;
        if (block.timestamp > uint256(r.anchor) + requesterDrawPriority || msg.sender == r.requester) {
            reward = r.eff * r.drawFees;
            ethOwed[msg.sender] += reward;
            r.rewards += reward;
        }
        emit JuryDrawn(aggId, msg.sender, reward);
    }

    function cancelUnsealed(bytes32 aggId) external override nonReentrant {
        Round storage r = _round(aggId);
        if (r.phase != PH_DRAW && r.phase != PH_BEACON) revert WrongPhase();
        if (r.sealedHash == bytes32(0) ? block.number <= uint256(r.requestBlock) + 1 + HISTORY_WINDOW
                                       : block.timestamp <= uint256(r.requestTime) + DRAW_GRACE) revert TooEarly();
        r.phase = PH_CANCELLED;
        ethOwed[treasury] += r.received;
        emit RoundCancelled(aggId, r.received);
    }

    function closeCommits(bytes32 aggId) external override nonReentrant {
        Round storage r = _round(aggId);
        if (r.phase != PH_COMMIT || block.timestamp <= r.windowEnd || r.commits < r.m || block.timestamp > r.deadline)
            revert WrongPhase();
        _closeWindow(r, aggId);
    }

    function promote(bytes32 aggId) external override nonReentrant {
        Round storage r = _round(aggId);
        if (r.phase != PH_CLOSING || block.timestamp > r.deadline) revert WrongPhase();
        if (block.number < uint256(r.closeBlock) + 2) revert TooEarly();
        r.phase = PH_REVEAL;
        uint40 rd = uint40(block.timestamp) + revealWindow;
        if (rd > r.deadline) r.deadline = rd;
        uint256 reward = r.eff * r.promoteFees;
        ethOwed[msg.sender] += reward;
        r.rewards += reward;
        emit CommitPhaseComplete(aggId, r.m);
    }

    function settle(bytes32 aggId) external override nonReentrant {
        Round storage r = _round(aggId);
        uint8 ph = r.phase;
        if (ph < PH_COMMIT || ph >= PH_SETTLED) revert WrongPhase();
        if (block.timestamp <= r.deadline) revert NotDue();
        bool failed = ph != PH_FINAL;
        if (failed) {
            _refund(r, aggId, ph == PH_CLOSING || (ph == PH_COMMIT && r.commits >= r.m) ? treasury : r.requester);
            emit EvaluationFailed(aggId, ph);
        }
        r.phase = failed ? PH_FAILED : PH_SETTLED;
        emit RoundSettled(aggId, failed);
    }

    function getEvaluation(bytes32 aggId)
        external
        view
        override
        returns (uint256[] memory aggregated, string memory justifications, bool valid)
    {
        Round storage r = _rounds[uint256(aggId)];
        return (r.aggregated, r.justifications, r.phase == PH_FINAL || r.phase == PH_SETTLED);
    }

    function getOutcomeScores(bytes32 aggId, uint256 outcome)
        external
        view
        override
        returns (uint256[] memory scores, bool valid)
    {
        Round storage r = _rounds[uint256(aggId)];
        if ((r.phase != PH_FINAL && r.phase != PH_SETTLED) || outcome >= r.aggregated.length) return (scores, false);
        scores = new uint256[](r.revealCount);
        for (uint256 i = 0; i < r.revealCount; i++) {
            uint256[] storage v = r.reveals[i];
            if (outcome < v.length) scores[i] = v[outcome];
        }
        valid = true;
    }

    function getRoundInfo(bytes32 aggId)
        external
        view
        override
        returns (
            uint8 phase, uint256 requestBlock, bytes32 sealedHash, uint256 closeBlock,
            uint256 received, uint256 baseFees, uint256 bonuses, uint256 rewards,
            uint256 deadline, uint256 windowEnd, uint256 commits, uint256 requestTime
        )
    {
        Round storage r = _rounds[uint256(aggId)];
        return (r.phase, r.requestBlock, r.sealedHash, r.closeBlock, r.received, r.baseFees, r.bonuses, r.rewards,
                r.deadline, r.windowEnd, r.commits, r.requestTime);
    }

    function isFailed(bytes32 aggId) external view override returns (bool) {
        return _rounds[uint256(aggId)].phase == PH_FAILED;
    }

    function beacons() external view override returns (address) {
        return beaconsEnabled ? address(this) : address(0);
    }

    /// @notice JuryBeacons.result's shape (beacons() is this contract): state 1 collecting, 2 the
    ///         quorum is in (draw), 3 missed (the next draw ends the round).
    function result(address, bytes32 aggId)
        external view returns (uint8 state, bytes32 mix, uint256 readyAt, address[] memory payees)
    {
        Round storage r = _rounds[uint256(aggId)];
        if (r.phase != PH_BEACON) return (0, bytes32(0), 0, payees);
        if (r.beaconAnswers >= r.beaconFees) return (2, keccak256(abi.encodePacked(aggId)), r.anchor, payees);
        if (r.beaconsDone) return (3, bytes32(0), 0, payees);
        return (1, bytes32(0), 0, payees);
    }

    function withdrawEth() external override nonReentrant {
        _withdrawTo(msg.sender);
    }

    function withdrawEthFor(address payee) external nonReentrant {
        _withdrawTo(payee);
    }

    // ------------------------------------------------------------------
    //                         views for tests
    // ------------------------------------------------------------------

    function getRequestCids(bytes32 aggId) external view returns (string[] memory) {
        return _requestCids[aggId];
    }

    function requesterOf(bytes32 aggId) external view returns (address) {
        return _rounds[uint256(aggId)].requester;
    }

    // ------------------------------------------------------------------
    //                           internals
    // ------------------------------------------------------------------

    function _round(bytes32 aggId) private view returns (Round storage r) {
        r = _rounds[uint256(aggId)];
        if (r.phase == 0) revert WrongPhase();
    }

    function _seal(Round storage r) private {
        if (block.number < uint256(r.requestBlock) + 2) revert TooEarly();
        if (block.number - (uint256(r.requestBlock) + 1) > HISTORY_WINDOW) revert SeedExpired();
        r.sealedHash = keccak256(abi.encodePacked(r.requestBlock, r.requestTime, roundCount));
    }

    function _closeWindow(Round storage r, bytes32 aggId) private {
        r.phase = PH_CLOSING;
        r.closeBlock = uint32(block.number);
        uint40 pd = uint40(block.timestamp) + PROMOTE_GRACE;
        if (pd > r.deadline) r.deadline = pd;
        emit CommitWindowClosed(aggId, block.number);
    }

    function _finalizeWith(Round storage r, bytes32 aggId, uint256[][] memory reveals, string memory justifications) private {
        uint256 len = _modalLength(reveals);
        uint256[] memory agg = new uint256[](len);
        for (uint256 i = 0; i < reveals.length; i++) {
            // the real aggregator ignores an empty or overlong reveal; the mock refuses to script one
            if (reveals[i].length == 0 || reveals[i].length > MAX_LIKELIHOOD_LENGTH) revert Unreachable();
            r.reveals[i] = reveals[i];
            for (uint256 j = 0; j < len && j < reveals[i].length; j++) agg[j] += reveals[i][j];
            emit RevealReceived(aggId, i, false, 0);
        }
        for (uint256 j = 0; j < len; j++) agg[j] /= reveals.length;
        r.revealCount = reveals.length;
        r.aggregated = agg;
        r.justifications = justifications;
        uint256 posted = arbiterFee != 0 && arbiterFee < r.eff ? arbiterFee : r.eff;
        uint256 juror = posted < r.minFee ? r.minFee : posted;
        uint256 bonus = juror * r.bonusMult;
        for (uint256 i = 0; i < r.p; i++) emit BonusPayment(aggId, i, ARBITERS, bonus);
        ethOwed[ARBITERS] += bonus * r.p;
        r.bonuses = bonus * r.p;
        r.phase = PH_FINAL;
        _refund(r, aggId, r.requester);
        emit FulfillAIEvaluation(aggId, agg, justifications);
    }

    /// @dev The most common reveal length, ties to the shorter (AggregatorLib.normalizeToModal).
    function _modalLength(uint256[][] memory reveals) private pure returns (uint256 modal) {
        uint256 best = 0;
        for (uint256 i = 0; i < reveals.length; i++) {
            uint256 li = reveals[i].length;
            uint256 c = 0;
            for (uint256 j = 0; j < reveals.length; j++) if (reveals[j].length == li) c++;
            if (c > best || (c == best && li < modal)) (best, modal) = (c, li);
        }
    }

    function _refund(Round storage r, bytes32 aggId, address to) private {
        uint256 refund = r.received - r.baseFees - r.bonuses - r.rewards;
        if (refund > 0) {
            ethOwed[to] += refund;
            emit RequesterRefunded(aggId, to, refund);
        }
    }

    function _withdrawTo(address payee) private {
        require(!withdrawBroken, "aggregator withdraw disabled");
        if (withdrawBurnsGas) {
            uint256 x;
            while (true) { x = x + 1; }
        }
        uint256 amount = ethOwed[payee];
        if (amount == 0) revert NothingOwed();
        ethOwed[payee] = 0;
        (bool ok, ) = payable(payee).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit EthWithdrawn(payee, amount);
    }

    /// @dev Spend about `amount` gas, as a costlier selection would (one memory expansion, not a loop:
    ///      solidity-coverage traces every EVM step and a long loop exhausted its memory).
    function _burnGas(uint256 amount) private {
        if (amount == 0) return;
        uint256 lo = 1;
        uint256 hi = 1 << 22;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (3 * mid + (mid * mid) / 512 >= amount) hi = mid;
            else lo = mid + 1;
        }
        uint256 word;
        assembly ("memory-safe") {
            word := mload(mul(sub(lo, 1), 32))
        }
        if (word != 0) requestGasCost = word;
    }
}
