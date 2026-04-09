// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev Mock Verdikta Aggregator for tests.
///      Lets the test harness pre-set evaluation results and control maxTotalFee.
contract MockVerdiktaAggregator {
    uint256 public feeMultiplier = 3; // maxTotalFee = input * multiplier

    struct Result {
        uint256[] scores;
        string    justificationCids;
        bool      exists;
    }

    mapping(bytes32 => Result) private _results;
    uint256 private _nonce;

    // --- Test helpers ---

    /// @dev Pre-set the result that getEvaluation will return for a given aggId.
    function setEvaluation(
        bytes32 aggId,
        uint256[] calldata scores,
        string calldata justCids,
        bool exists
    ) external {
        _results[aggId] = Result(scores, justCids, exists);
    }

    function setFeeMultiplier(uint256 m) external {
        feeMultiplier = m;
    }

    // --- IVerdiktaAggregator implementation ---

    function requestAIEvaluationWithApproval(
        string[] memory,
        string memory,
        uint256,
        uint256,
        uint256,
        uint256,
        uint64
    ) external returns (bytes32 requestId) {
        _nonce++;
        requestId = keccak256(abi.encodePacked(_nonce, msg.sender));
    }

    function getEvaluation(bytes32 _requestId)
        external
        view
        returns (uint256[] memory, string memory, bool)
    {
        Result storage r = _results[_requestId];
        return (r.scores, r.justificationCids, r.exists);
    }

    function maxTotalFee(uint256 requestedMaxOracleFee) external view returns (uint256) {
        return requestedMaxOracleFee * feeMultiplier;
    }

    function responseTimeoutSeconds() external pure returns (uint256) {
        return 300;
    }

    function finalizeEvaluationTimeout(bytes32) external {
        // no-op in mock
    }
}
