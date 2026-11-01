// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IVerdiktaAggregator} from "../interfaces/IVerdiktaAggregator.sol";

/// @title MockVerdiktaAggregator (stake attestation)
/// @notice Test double for the deployed ReputationAggregator (verdikta-dispatcher,
///         reputationBasedAggregator/contracts/ReputationAggregator.sol), adapted from
///         example-bounty-program's mock. It reproduces what a requester can observe of the real
///         contract and nothing the real contract does not do:
///         - Poll-only. The aggregator never calls the requester. A requester reads the result
///           with getEvaluation / getAggregationStatus and pulls its unspent ETH, credited to
///           ethOwed at settlement, with withdrawEth. There is no receive(): plain ETH reverts.
///         - Fund-from-credit. A request draws min(ethOwed[caller], required) first and
///           msg.value must cover the rest. Everything received (credit + msg.value) belongs to
///           the round; the part the oracles do not spend is credited back at settlement. The
///           oracles never spend more than `required` (maxTotalFee at request time), so funding
///           above it always comes back.
///         - The same input limits, keeper selection checks, pause gate, reentrancy guard,
///           request-id construction, custom errors and events.
///         - Settlement by a scripted result (the round finalizing once enough reveals arrive)
///           or by finalizeEvaluationTimeout after responseTimeoutSeconds: failed, or valid when
///           a late result was staged (the real contract's "enough responses after all" branch,
///           which a requester rarely meets but must handle).
/// @dev    Test controls stand in for the owner-only setters and for the oracles:
///         setMaxOracleFee, setResponseTimeout, setPaused (owner-only on the real contract),
///         setFeeMultiplier (the real multiplier is K + B*P from its config), setRefundAmount
///         (how much of a round's worst-case cost the oracles leave unspent), scriptResult,
///         scriptLateResult.
///         A scripted vector must have a length a real round can produce (2..maxLikelihoodLength,
///         the real reveal bounds); its values are free, so malformed vectors can be tested.
contract MockVerdiktaAggregator is IVerdiktaAggregator, ReentrancyGuard, Pausable {
    // ---- the real contract's limits ----
    uint256 public constant MAX_CID_COUNT = 10;
    uint256 public constant MAX_CID_LENGTH = 100;
    uint256 public constant MAX_ADDENDUM_LENGTH = 1000;
    uint256 public constant MIN_LIKELIHOOD_LENGTH = 2; // a reveal with fewer scores is ignored
    uint256 public maxLikelihoodLength = 20;           // a reveal with more scores is ignored

    // ---- the real contract's errors ----
    error EmptyCIDList();
    error TooManyCIDs();
    error CIDTooLong();
    error AddendumTooLong();
    error InsufficientPayment();
    error UnknownRequest();
    error AggregationComplete();
    error NotTimedOut();
    error NothingOwed();
    error EthTransferFailed();

    /// @dev Mock-only: a scripted vector no real round could produce.
    error UnreachableResult(uint256 length);

    // ---- the real contract's events (RequestAIEvaluation, FulfillAIEvaluation via the interface) ----
    event RequestFunded(bytes32 indexed aggRequestId, address indexed requester, uint256 fromCredit, uint256 fromValue);
    event RequesterRefunded(bytes32 indexed aggRequestId, address indexed requester, uint256 amount);
    event EvaluationTimedOut(bytes32 indexed aggRequestId);
    event EvaluationFailed(bytes32 indexed aggRequestId, string phase);
    event EthWithdrawn(address indexed payee, uint256 amount);

    // ---- configuration (owner-set on the real contract) ----
    uint256 public override maxOracleFee = 0.0004 ether; // live value on both networks
    uint256 public override responseTimeoutSeconds = 300;
    uint256 public feeMultiplier = 3;                    // stands in for K + B*P
    uint256 public refundAmount;                         // unspent part of `required`, per round

    mapping(address => uint256) public override ethOwed;

    struct Round {
        address requester;
        uint256 startTimestamp; // 0 = unknown id
        uint256 required;       // maxTotalFee at request time: the most the oracles can spend
        uint256 ethReceived;    // fromCredit + msg.value, at least `required`
        bool isComplete;
        bool failed;
        uint256[] likelihoods;
        string justificationCids;
        bool lateStaged;
        uint256[] lateLikelihoods;
        string lateJustificationCids;
    }
    mapping(bytes32 => Round) private _rounds;

    /// @dev What the requester forwarded, so tests can assert the request composition.
    struct RequestParams {
        string addendum;
        uint256 alpha;
        uint256 maxFee;
        uint256 estimatedBaseCost;
        uint256 maxFeeBasedScaling;
        uint64 requestedClass;
    }
    mapping(bytes32 => RequestParams) public requestParams;
    mapping(bytes32 => string[]) private _requestCids;

    uint256 private _requestCounter;

    // ------------------------------------------------------------------
    //                         test controls
    // ------------------------------------------------------------------

    function setMaxOracleFee(uint256 fee) external { maxOracleFee = fee; }
    function setResponseTimeout(uint256 secs) external { responseTimeoutSeconds = secs; }
    function setMaxLikelihoodLength(uint256 len) external { maxLikelihoodLength = len; }
    function setFeeMultiplier(uint256 m) external { feeMultiplier = m; }
    function setRefundAmount(uint256 amount) external { refundAmount = amount; }

    function setPaused(bool p) external {
        if (p) _pause();
        else _unpause();
    }

    /// @notice Finalize an open round with this aggregated result, as the real contract does when
    ///         the N-th reveal arrives (also after the timeout, until someone finalizes it).
    function scriptResult(bytes32 aggId, uint256[] calldata likelihoods, string calldata justificationCids)
        external
    {
        Round storage r = _openRound(aggId);
        _checkReachable(likelihoods.length);
        r.likelihoods = likelihoods;
        r.justificationCids = justificationCids;
        _finalize(aggId, r);
    }

    /// @notice Stage a result that finalizeEvaluationTimeout delivers instead of failing the round.
    function scriptLateResult(bytes32 aggId, uint256[] calldata likelihoods, string calldata justificationCids)
        external
    {
        Round storage r = _openRound(aggId);
        _checkReachable(likelihoods.length);
        r.lateStaged = true;
        r.lateLikelihoods = likelihoods;
        r.lateJustificationCids = justificationCids;
    }

    // ------------------------------------------------------------------
    //                    IVerdiktaAggregator
    // ------------------------------------------------------------------

    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 _alpha,
        uint256 _maxFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    ) external payable override nonReentrant whenNotPaused returns (bytes32 aggId) {
        if (cids.length == 0) revert EmptyCIDList();
        if (cids.length > MAX_CID_COUNT) revert TooManyCIDs();
        for (uint256 i = 0; i < cids.length; i++) {
            if (bytes(cids[i]).length > MAX_CID_LENGTH) revert CIDTooLong();
        }
        if (bytes(addendumText).length > MAX_ADDENDUM_LENGTH) revert AddendumTooLong();

        // Fund the round: existing credit first, then msg.value.
        uint256 effMaxFee = _maxFee < maxOracleFee ? _maxFee : maxOracleFee;
        uint256 required = effMaxFee * feeMultiplier;
        uint256 credit = ethOwed[msg.sender];
        uint256 fromCredit = credit < required ? credit : required;
        if (msg.value + fromCredit < required) revert InsufficientPayment();
        ethOwed[msg.sender] = credit - fromCredit;

        // The real request id: the mode-1 CID string, time, caller and a counter.
        bytes memory cat;
        for (uint256 i = 0; i < cids.length; i++) {
            cat = abi.encodePacked(cat, cids[i], i < cids.length - 1 ? "," : "");
        }
        string memory cidConcat = string(cat);
        if (bytes(addendumText).length > 0) {
            cidConcat = string(abi.encodePacked(cidConcat, ":", addendumText));
        }
        cidConcat = string(abi.encodePacked("1:", cidConcat));
        _requestCounter++;
        aggId = keccak256(abi.encodePacked(block.timestamp, msg.sender, cidConcat, _requestCounter));

        Round storage r = _rounds[aggId];
        r.requester = msg.sender;
        r.startTimestamp = block.timestamp;
        r.required = required;
        r.ethReceived = fromCredit + msg.value;
        emit RequestFunded(aggId, msg.sender, fromCredit, msg.value);

        // ReputationKeeper.selectOracles' checks, applied to the clamped fee.
        require(_estimatedBaseCost < effMaxFee, "Base cost must be less than max fee");
        require(_maxFeeBasedScalingFactor >= 1, "Max scaling factor must be at least 1");
        // The keeper scores each eligible oracle with weight (1000 - alpha), checked: an alpha
        // above 1000 reverts with panic 0x11.
        _qualityWeight(_alpha);

        requestParams[aggId] = RequestParams(
            addendumText, _alpha, _maxFee, _estimatedBaseCost, _maxFeeBasedScalingFactor, _requestedClass
        );
        _requestCids[aggId] = cids;
        emit RequestAIEvaluation(aggId, cids);
    }

    function getEvaluation(bytes32 aggId)
        external
        view
        override
        returns (uint256[] memory likelihoods, string memory justificationCID, bool exists)
    {
        Round storage r = _rounds[aggId];
        exists = r.isComplete && !r.failed && r.likelihoods.length > 0;
        return (r.likelihoods, r.justificationCids, exists);
    }

    function getAggregationStatus(bytes32 aggId)
        external
        view
        override
        returns (
            bool isComplete,
            bool failed,
            bool commitPhaseComplete,
            uint256 commitExpected,
            uint256 commitReceived,
            uint256 responseCount,
            uint256 requiredN,
            uint256 clusterP,
            address requester,
            uint256 startTimestamp
        )
    {
        Round storage r = _rounds[aggId];
        // A round with a result, or a staged late one, has had its commits and reveals.
        bool revealed = r.lateStaged || (r.isComplete && !r.failed);
        return (
            r.isComplete, r.failed, revealed, 1, revealed ? 1 : 0, revealed ? 1 : 0, 1, 1,
            r.requester, r.startTimestamp
        );
    }

    function maxTotalFee(uint256 requestedMaxOracleFee) external view override returns (uint256) {
        uint256 eff = requestedMaxOracleFee < maxOracleFee ? requestedMaxOracleFee : maxOracleFee;
        return eff * feeMultiplier;
    }

    function withdrawEth() external override nonReentrant {
        uint256 amount = ethOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        ethOwed[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit EthWithdrawn(msg.sender, amount);
    }

    function finalizeEvaluationTimeout(bytes32 aggId) external override nonReentrant {
        Round storage r = _rounds[aggId];
        if (r.startTimestamp == 0) revert UnknownRequest();
        if (r.isComplete) revert AggregationComplete();
        if (block.timestamp < r.startTimestamp + responseTimeoutSeconds) revert NotTimedOut();

        if (r.lateStaged) {
            r.likelihoods = r.lateLikelihoods;
            r.justificationCids = r.lateJustificationCids;
            _finalize(aggId, r);
            return;
        }
        _refundRequester(aggId, r);
        r.failed = true;
        r.isComplete = true;
        emit EvaluationTimedOut(aggId);
        emit EvaluationFailed(aggId, "commit");
    }

    // ------------------------------------------------------------------
    //                         views for tests
    // ------------------------------------------------------------------

    function ethReceived(bytes32 aggId) external view returns (uint256) {
        return _rounds[aggId].ethReceived;
    }

    function getRequestCids(bytes32 aggId) external view returns (string[] memory) {
        return _requestCids[aggId];
    }

    // ------------------------------------------------------------------
    //                           internals
    // ------------------------------------------------------------------

    function _openRound(bytes32 aggId) private view returns (Round storage r) {
        r = _rounds[aggId];
        if (r.startTimestamp == 0) revert UnknownRequest();
        if (r.isComplete) revert AggregationComplete();
    }

    function _qualityWeight(uint256 alpha) private pure returns (uint256) {
        return 1000 - alpha;
    }

    function _checkReachable(uint256 length) private view {
        if (length < MIN_LIKELIHOOD_LENGTH || length > maxLikelihoodLength) revert UnreachableResult(length);
    }

    function _finalize(bytes32 aggId, Round storage r) private {
        r.isComplete = true;
        _refundRequester(aggId, r);
        emit FulfillAIEvaluation(aggId, r.likelihoods, r.justificationCids);
    }

    /// @dev The real refund is ethReceived - base - bonus, and base + bonus <= required. The
    ///      oracles here spend required - refundAmount (at least 0), so the refund is never less
    ///      than ethReceived - required. It is credited, never pushed: the requester pulls it.
    function _refundRequester(bytes32 aggId, Round storage r) private {
        uint256 unspent = refundAmount < r.required ? refundAmount : r.required;
        uint256 refund = r.ethReceived - (r.required - unspent);
        if (refund > 0) {
            ethOwed[r.requester] += refund;
            emit RequesterRefunded(aggId, r.requester, refund);
        }
    }
}
