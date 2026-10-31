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
///      started again by its requester.
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

    /// @dev Start the evaluation, funding the request with the attached ETH. This wallet is
    ///      msg.sender to the aggregator, so refunds accrue to ethOwed[this].
    function startEvaluation(
        string[] calldata cids,
        string calldata addendumText,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScaling,
        uint64  requestedClass
    ) external payable onlyRequester returns (bytes32) {
        require(!started, "already started");
        started = true;

        bytes32 id = verdikta.requestAIEvaluationWithApproval{value: msg.value}(
            cids,
            addendumText,
            alpha,
            maxOracleFee,
            estimatedBaseCost,
            maxFeeBasedScaling,
            requestedClass
        );
        aggId = id;
        return id;
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
