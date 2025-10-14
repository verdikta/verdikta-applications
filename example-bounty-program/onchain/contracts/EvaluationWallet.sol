// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IERC20} from "./interfaces/ILinkToken.sol";
import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";

/// @notice One-per-submission wallet that holds the hunter's LINK.
///         Verdikta pulls LINK from *this* wallet (msg.sender to Verdikta is this contract).
contract EvaluationWallet {
    address public immutable bountyContract;   // only this can operate
    address public immutable hunter;           // leftover LINK refund address
    IERC20  public immutable link;
    IVerdiktaAggregator public immutable verdikta;

    bytes32 public aggId;
    bool    public started;

    modifier onlyBounty() {
        require(msg.sender == bountyContract, "Not bounty");
        _;
    }

    constructor(address _bounty, address _hunter, IERC20 _link, IVerdiktaAggregator _verdikta) {
        bountyContract = _bounty;
        hunter = _hunter;
        link = _link;
        verdikta = _verdikta;
    }

    /// @dev Pull LINK from hunter into this wallet (hunter must have approved this wallet).
    function pullLinkFromHunter(uint256 amount) external onlyBounty {
        require(link.transferFrom(hunter, address(this), amount), "LINK pull failed");
    }

    /// @dev Approve Verdikta for up to `amount` LINK.
    function approveVerdikta(uint256 amount) external onlyBounty {
        // reset allowance first (safer for some ERC-20 implementations)
        require(link.approve(address(verdikta), 0), "approve reset failed");
        require(link.approve(address(verdikta), amount), "approve failed");
    }

    /// @dev Start the Verdikta evaluation. This wallet becomes msg.sender to Verdikta.
    function startEvaluation(
        string[] calldata cids,
        string calldata addendumText,
        uint256 alpha,
        uint256 maxOracleFee,
        uint256 estimatedBaseCost,
        uint256 maxFeeBasedScaling,
        uint64  requestedClass
    ) external onlyBounty returns (bytes32) {
        require(!started, "Already started");
        started = true;

        bytes32 id = verdikta.requestAIEvaluationWithApproval(
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

    /// @dev Refund leftover LINK back to hunter.
    function refundLeftoverLink() external onlyBounty {
        uint256 bal = link.balanceOf(address(this));
        if (bal > 0) {
            require(link.transfer(hunter, bal), "refund failed");
        }
    }
}

