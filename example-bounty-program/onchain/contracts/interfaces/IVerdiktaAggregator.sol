// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVerdiktaAggregator
 * @notice Interface for interacting with the Verdikta AI Aggregator contract
 * @dev This interface defines the methods needed to request AI evaluations from Verdikta
 */
interface IVerdiktaAggregator {
    /**
     * @notice Request an AI evaluation with LINK token approval
     * @param cids Array of IPFS CIDs containing query data
     * @param addendumText Optional additional text to append to query
     * @param _alpha Aggregation parameter for arbiter selection
     * @param _maxFee Maximum fee willing to pay for evaluation
     * @param _estimatedBaseCost Estimated base cost for the evaluation
     * @param _maxFeeBasedScalingFactor Scaling factor for fee calculation
     * @param _requestedClass Class ID determining which AI models to use (e.g., 128 for frontier models)
     * @return requestId Unique identifier for this evaluation request
     */
    function requestAIEvaluationWithApproval(
        string[] memory cids,
        string memory addendumText,
        uint256 _alpha,
        uint256 _maxFee,
        uint256 _estimatedBaseCost,
        uint256 _maxFeeBasedScalingFactor,
        uint64 _requestedClass
    ) external returns (bytes32 requestId);

    /**
     * @notice Get the evaluation result for a given request ID
     * @param _requestId The request ID to query
     * @return likelihoods Array of likelihood scores for each outcome
     * @return justificationCID IPFS CID containing AI justification
     * @return exists Whether the evaluation exists
     */
    function getEvaluation(bytes32 _requestId)
        external
        view
        returns (
            uint256[] memory likelihoods,
            string memory justificationCID,
            bool exists
        );

    /**
     * @notice Calculate the maximum total fee for an evaluation
     * @param requestedMaxOracleFee The requested maximum oracle fee
     * @return Maximum total fee in LINK tokens
     */
    function maxTotalFee(uint256 requestedMaxOracleFee)
        external
        view
        returns (uint256);

    /**
     * @notice Get the response timeout in seconds
     * @return Timeout duration in seconds
     */
    function responseTimeoutSeconds() external view returns (uint256);

    /**
     * @notice Finalize an evaluation that has timed out
     * @param aggId The aggregation ID that timed out
     */
    function finalizeEvaluationTimeout(bytes32 aggId) external;

    /**
     * @notice Event emitted when an AI evaluation is requested
     * @param requestId Unique identifier for the request
     * @param cids Array of IPFS CIDs containing query data
     */
    event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);

    /**
     * @notice Event emitted when an AI evaluation is fulfilled
     * @param requestId Unique identifier for the request
     * @param likelihoods Array of likelihood scores
     * @param justificationCID IPFS CID containing justification
     */
    event FulfillAIEvaluation(
        bytes32 indexed requestId,
        uint256[] likelihoods,
        string justificationCID
    );
}

