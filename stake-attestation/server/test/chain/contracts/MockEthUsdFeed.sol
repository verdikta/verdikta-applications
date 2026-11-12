// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// @title MockEthUsdFeed
/// @notice A stand-in for a Chainlink ETH/USD aggregator (AggregatorV3Interface's read side), for
///         the server's label tests: no live feed is read in any test. `set` publishes a round
///         with the answer and the update time the test chooses (a stale or a bad answer included).
contract MockEthUsdFeed {
    uint8 public immutable decimals;
    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        _set(answer_, block.timestamp);
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        _set(answer_, updatedAt_);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function _set(int256 answer_, uint256 updatedAt_) private {
        _roundId += 1;
        _answer = answer_;
        _updatedAt = updatedAt_;
    }
}
