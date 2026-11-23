// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";

/// @notice One wallet per evaluation request, funding it with ETH. Adapted from
///         example-bounty-program's EvaluationWallet (only the names differ): the wallet is
///         msg.sender to the aggregator, so the unspent part of the prepay is credited to
///         ethOwed[this wallet] and never mixes with another request's or another payer's.
/// @dev Deployed ONCE by StakeAttestation's constructor as an implementation; every request
///      (a reveal; later a re-trigger or a dispute) gets an EIP-1167 clone of it
///      (Clones.clone, about 40k gas instead of a full deployment). The two immutables are part
///      of the implementation's code, so every clone sees them under delegatecall; `aggId` and
///      `started` are per-clone storage. The implementation itself is never operated.
///      A start that reverts leaves `started` false, so a clone whose submission failed can be
///      started again by its requester. The v2 aggregator draws the jury in a second step
///      (drawJury), which the requester calls through this wallet so the draw reward is the
///      round's funder's.
contract EvaluationWallet {
    address public immutable requester;   // the StakeAttestation contract: the only operator
    IVerdiktaAggregator public immutable verdikta;

    bytes32 public aggId;
    bool    public started;

    modifier onlyRequester() {
        require(msg.sender == requester, "not requester");
        _;
    }

    constructor(address requester_, IVerdiktaAggregator verdikta_) {
        requester = requester_;
        verdikta = verdikta_;
    }

    /// @dev The request's settings (IVerdiktaAggregator.requestAIEvaluationWithApproval's arguments
    ///      after the CIDs), as one struct, as example-bounty-program's wallet takes them: nine
    ///      arguments would not fit the stack of the caller's try/catch.
    struct Request {
        string  addendumText;
        uint256 alpha;
        uint256 maxOracleFee;
        uint256 minOracleFee;
        uint256 estimatedBaseCost;
        uint256 maxFeeBasedScaling;
        uint64  requestedClass;
        bool    withBeacons;
    }

    /// @dev Start the evaluation, funding the request with the attached ETH. This wallet is
    ///      msg.sender to the aggregator, so refunds and the draw reward accrue to ethOwed[this].
    function startEvaluation(string[] calldata cids, Request calldata q)
        external payable onlyRequester returns (bytes32 id)
    {
        require(!started, "already started");
        started = true;

        id = verdikta.requestAIEvaluationWithApproval{value: msg.value}(
            cids,
            q.addendumText,
            q.alpha,
            q.maxOracleFee,
            q.minOracleFee,
            q.estimatedBaseCost,
            q.maxFeeBasedScaling,
            q.requestedClass,
            q.withBeacons
        );
        aggId = id;
    }

    /// @dev Draw the round's jury as its requester (the v2 aggregator's second step, from block
    ///      B+2), so the draw reward (2 x the clamped fee; the requester's alone for 30 s, anyone's
    ///      after) is credited to this wallet and comes back to the round's funder with the
    ///      leftover. With beacons it is called twice: the first call starts the beacon stage,
    ///      the second draws. The aggregator's revert (too early, wrong phase, DrawExpired) is
    ///      passed on.
    function drawJury() external onlyRequester {
        verdikta.drawJury(aggId);
    }

    /// @dev Pull any ethOwed credit from the aggregator, then hand the wallet's whole balance to
    ///      the requester, which routes it to whoever funded the request. Handing it to the
    ///      requester rather than pushing to the payer keeps a payer that rejects ETH from
    ///      blocking resolution. Idempotent.
    /// @return refunded The amount (wei) returned to the requester.
    function refundLeftoverEth() external onlyRequester returns (uint256 refunded) {
        if (verdikta.ethOwed(address(this)) > 0) {
            verdikta.withdrawEth();
        }
        refunded = address(this).balance;
        if (refunded > 0) {
            (bool ok,) = payable(requester).call{value: refunded}("");
            require(ok, "repatriate failed");
        }
    }

    receive() external payable {}
}
