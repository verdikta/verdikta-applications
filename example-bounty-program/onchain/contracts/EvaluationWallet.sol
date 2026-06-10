// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";

/// @notice One-per-submission wallet that funds a single Verdikta evaluation with ETH.
///         The wallet is msg.sender to Verdikta, so any unspent prepay is refunded to
///         ethOwed[this] and recovered via withdrawEth() before being returned to the hunter.
contract EvaluationWallet {
    address public immutable bountyContract;   // only this can operate
    address public immutable hunter;           // leftover ETH refund address
    IVerdiktaAggregator public immutable verdikta;

    bytes32 public aggId;
    bool    public started;

    modifier onlyBounty() {
        require(msg.sender == bountyContract, "Not bounty");
        _;
    }

    constructor(address _bounty, address _hunter, IVerdiktaAggregator _verdikta) {
        bountyContract = _bounty;
        hunter = _hunter;
        verdikta = _verdikta;
    }

    /// @dev Start the Verdikta evaluation, funding the request with the attached ETH.
    ///      This wallet becomes msg.sender to Verdikta, so refunds accrue to ethOwed[this].
    function startEvaluation(
        string[] calldata cids,
        string calldata addendumText,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScaling,
        uint64  requestedClass
    ) external payable onlyBounty returns (bytes32) {
        require(!started, "Already started");
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

    /// @dev Recover any ETH refund credited to this wallet (ethOwed) from Verdikta, then hand
    ///      the wallet's full ETH balance back to the BountyEscrow, which routes it to the
    ///      hunter (or credits it for later withdrawal). Handing it to the trusted bounty
    ///      contract — rather than pushing to the hunter here — keeps a hunter that can't
    ///      receive ETH from being able to revert and brick submission resolution.
    /// @return refunded The amount of ETH (wei) returned to the BountyEscrow for the hunter.
    function refundLeftoverEth() external onlyBounty returns (uint256 refunded) {
        if (verdikta.ethOwed(address(this)) > 0) {
            verdikta.withdrawEth();
        }
        refunded = address(this).balance;
        if (refunded > 0) {
            (bool ok,) = payable(bountyContract).call{value: refunded}("");
            require(ok, "repatriate failed");
        }
    }

    receive() external payable {}
}
