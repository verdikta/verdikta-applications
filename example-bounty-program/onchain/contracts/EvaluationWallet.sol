// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";

/// @notice One-per-submission wallet that funds a submission's Verdikta rounds with ETH.
///         The wallet is the requester to the aggregator, so the unspent prepay of every round and
///         the draw reward (the requester's alone within 30 s of the request) are credited to
///         ethOwed[this]; refundLeftoverEth() recovers them for the BountyEscrow, which pays
///         whoever funded the round (Submission.funder).
/// @dev Deployed ONCE by the escrow's constructor as an implementation; every submission gets an
///      EIP-1167 minimal-proxy clone (BountyEscrow.walletImplementation / Clones.clone), ~40k gas
///      instead of a full deployment. `bountyContract` and `verdikta` are immutables (part of the
///      shared code): one aggregator serves every jury size, and the jury goes with each request
///      (Request.jury). The implementation itself is never operated.
contract EvaluationWallet {
    address public immutable bountyContract;   // only this can operate

    IVerdiktaAggregator public immutable verdikta;   // the escrow's aggregator
    bytes32 public aggId;                      // the latest round
    uint8   public rounds;                     // rounds started (a submission may re-run, item 12)

    modifier onlyBounty() {
        require(msg.sender == bountyContract, "Not bounty");
        _;
    }

    constructor(address _bounty, IVerdiktaAggregator _verdikta) {
        bountyContract = _bounty;
        verdikta = _verdikta;
    }

    /// @dev The request's settings (IVerdiktaAggregator.requestAIEvaluationWithApproval's arguments
    ///      after the CIDs), as one struct.
    struct Request {
        string  addendumText;
        uint256 alpha;
        uint256 maxOracleFee;
        uint256 minOracleFee;
        uint256 estimatedBaseCost;
        uint256 maxFeeBasedScaling;
        uint64  requestedClass;
        bool    withBeacons;
        IVerdiktaAggregator.Jury jury;   // the bounty's jury
    }

    /// @dev Start a round, funding the request with the attached ETH. The escrow starts a new round
    ///      only once the previous one is resolved (re-runs, item 12).
    function startEvaluation(string[] calldata cids, Request calldata q)
        external payable onlyBounty returns (bytes32 id)
    {
        id = verdikta.requestAIEvaluationWithApproval{value: msg.value}(
            cids,
            q.addendumText,
            q.alpha,
            q.maxOracleFee,
            q.minOracleFee,
            q.estimatedBaseCost,
            q.maxFeeBasedScaling,
            q.requestedClass,
            q.withBeacons,
            q.jury
        );
        aggId = id;
        rounds += 1;
    }

    /// @dev Draw the current round's jury as its requester, so the draw reward comes back with the
    ///      leftover. With beacons the escrow is called twice (start the stage, then draw).
    function drawJury() external onlyBounty {
        verdikta.drawJury(aggId);
    }

    /// @dev Recover any ETH credited to this wallet (ethOwed: refunds and draw rewards) from Verdikta,
    ///      then hand the wallet's whole balance back to the BountyEscrow, which routes it to the
    ///      round's funder (or credits it for later withdrawal). Handing it to the trusted bounty
    ///      contract, rather than pushing to the funder here, keeps a funder that can't receive ETH
    ///      from bricking resolution.
    /// @return refunded The amount of ETH (wei) returned to the BountyEscrow.
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
