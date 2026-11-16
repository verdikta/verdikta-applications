// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IVerdiktaAggregator} from "../interfaces/IVerdiktaAggregator.sol";

/// @dev A requester that only polls, for tests of the aggregator mock. Any call or ETH it receives
///      other than its own withdrawal is counted in unexpectedCalls, so a test can prove the
///      aggregator never calls a requester back.
contract MockPollingRequester {
    IVerdiktaAggregator public immutable aggregator;
    bytes32 public lastRequestId;
    uint256 public unexpectedCalls;
    bool private _withdrawing;

    constructor(IVerdiktaAggregator aggregator_) {
        aggregator = aggregator_;
    }

    function request(
        string[] calldata cids,
        string calldata addendum,
        uint256 alpha,
        uint256 maxFee,
        uint256 estimatedBaseCost,
        uint256 scaling,
        uint64 requestedClass
    ) external payable {
        lastRequestId = aggregator.requestAIEvaluationWithApproval{value: msg.value}(
            cids, addendum, alpha, maxFee, estimatedBaseCost, scaling, requestedClass
        );
    }

    function withdraw() external {
        _withdrawing = true;
        aggregator.withdrawEth();
        _withdrawing = false;
    }

    receive() external payable {
        if (!_withdrawing) unexpectedCalls++;
    }

    fallback() external payable {
        unexpectedCalls++;
    }
}
