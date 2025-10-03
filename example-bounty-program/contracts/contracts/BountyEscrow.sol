// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IVerdiktaAggregator.sol";

/**
 * @title BountyEscrow
 * @notice Escrow contract for AI-evaluated bounties using Verdikta
 * @dev Manages bounty creation, submissions, AI evaluation via Verdikta, and automatic payouts
 * @author Verdikta Team
 */
contract BountyEscrow is ReentrancyGuard, Ownable {
    // ============================================================
    //                      STATE VARIABLES
    // ============================================================

    /// @notice Verdikta Aggregator contract for AI evaluations
    IVerdiktaAggregator public verdiktaAggregator;

    /// @notice LINK token contract for paying evaluation fees
    IERC20 public linkToken;

    /// @notice Counter for generating unique bounty IDs
    uint256 private _bountyIdCounter;

    /// @notice Mapping from bounty ID to Bounty struct
    mapping(uint256 => Bounty) public bounties;

    /// @notice Mapping from submission ID to Submission struct
    mapping(bytes32 => Submission) public submissions;

    /// @notice Mapping from bounty ID to array of submission IDs
    mapping(uint256 => bytes32[]) public bountySubmissions;

    /// @notice Mapping from Verdikta request ID to submission ID
    mapping(bytes32 => bytes32) public verdiktaRequestToSubmission;

    /// @notice Duration after bounty creation during which cancellation is not allowed (24 hours)
    uint256 public constant CANCEL_LOCK_DURATION = 24 hours;

    /// @notice Minimum ETH amount for a bounty (prevents dust bounties)
    uint256 public constant MIN_BOUNTY_AMOUNT = 0.001 ether;

    // ============================================================
    //                      DATA STRUCTURES
    // ============================================================

    /// @notice Status of a bounty
    enum BountyStatus {
        Open,       // Accepting submissions
        Evaluating, // Has active evaluation in progress
        Paid,       // Winner has been paid
        Cancelled   // Cancelled by creator
    }

    /// @notice Status of a submission
    enum SubmissionStatus {
        Pending,    // Submitted but not yet evaluated
        Evaluating, // Currently being evaluated by Verdikta
        Passed,     // Passed evaluation and won bounty
        Failed,     // Failed evaluation
        TimedOut    // Evaluation timed out
    }

    /// @notice Bounty information
    struct Bounty {
        address creator;           // Address of bounty creator
        uint256 payoutAmount;      // Amount in Wei to pay winner
        string rubricCid;          // IPFS CID of evaluation rubric
        uint64 classId;            // Verdikta class ID for AI models
        BountyStatus status;       // Current status
        uint256 createdAt;         // Block timestamp of creation
        uint256 cancelLockUntil;   // Timestamp until which cancellation is locked
        bytes32 winningSubmission; // ID of winning submission (if any)
    }

    /// @notice Submission information
    struct Submission {
        uint256 bountyId;          // Associated bounty ID
        address hunter;            // Address of submitter
        string deliverableCid;     // IPFS CID of deliverable
        bytes32 verdiktaRequestId; // Verdikta's request ID
        uint256 submittedAt;       // Block timestamp of submission
        SubmissionStatus status;   // Current status
        uint8 score;               // AI evaluation score (0-100)
        string reportCid;          // IPFS CID of AI report
    }

    // ============================================================
    //                          EVENTS
    // ============================================================

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 payoutAmount,
        string rubricCid,
        uint64 classId,
        uint256 cancelLockUntil
    );

    event SubmissionQueued(
        uint256 indexed bountyId,
        bytes32 indexed submissionId,
        address indexed hunter,
        string deliverableCid,
        bytes32 verdiktaRequestId
    );

    event EvaluationResult(
        uint256 indexed bountyId,
        bytes32 indexed submissionId,
        bool pass,
        uint8 score,
        string reportCid
    );

    event BountyPaid(
        uint256 indexed bountyId,
        bytes32 indexed submissionId,
        address indexed winner,
        uint256 amountWei
    );

    event BountyCancelled(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 refundedAmount
    );

    event SubmissionRefunded(
        bytes32 indexed submissionId,
        address indexed hunter,
        string reason
    );

    event VerdiktaAggregatorUpdated(address indexed oldAddress, address indexed newAddress);
    event LinkTokenUpdated(address indexed oldAddress, address indexed newAddress);

    // ============================================================
    //                        CONSTRUCTOR
    // ============================================================

    /**
     * @notice Initialize the BountyEscrow contract
     * @param _verdiktaAggregator Address of Verdikta Aggregator contract
     * @param _linkToken Address of LINK token contract
     */
    constructor(address _verdiktaAggregator, address _linkToken) Ownable(msg.sender) {
        require(_verdiktaAggregator != address(0), "Invalid Verdikta address");
        require(_linkToken != address(0), "Invalid LINK address");
        
        verdiktaAggregator = IVerdiktaAggregator(_verdiktaAggregator);
        linkToken = IERC20(_linkToken);
    }

    // ============================================================
    //                    BOUNTY MANAGEMENT
    // ============================================================

    /**
     * @notice Create a new bounty with ETH escrow
     * @param rubricCid IPFS CID of the rubric JSON
     * @param classId Verdikta class ID for evaluation (default: 128)
     * @return bountyId Unique identifier for the bounty
     * @dev Requires msg.value >= MIN_BOUNTY_AMOUNT
     */
    function createBounty(
        string calldata rubricCid,
        uint64 classId
    ) external payable returns (uint256 bountyId) {
        // TODO: Implement bounty creation logic
        // 1. Validate inputs (msg.value >= MIN_BOUNTY_AMOUNT, non-empty rubricCid)
        // 2. Increment _bountyIdCounter
        // 3. Create Bounty struct with:
        //    - creator = msg.sender
        //    - payoutAmount = msg.value
        //    - rubricCid = rubricCid
        //    - classId = classId (default to 128 if 0)
        //    - status = BountyStatus.Open
        //    - createdAt = block.timestamp
        //    - cancelLockUntil = block.timestamp + CANCEL_LOCK_DURATION
        // 4. Store bounty in mapping
        // 5. Emit BountyCreated event
        // 6. Return bountyId
        
        revert("TODO: Implement createBounty");
    }

    /**
     * @notice Cancel a bounty (only after 24h lockout, no active evaluations)
     * @param bountyId The bounty to cancel
     * @dev Only callable by bounty creator
     * @dev Refunds ETH to creator, marks pending submissions as void
     */
    function cancelBounty(uint256 bountyId) external nonReentrant {
        // TODO: Implement bounty cancellation logic
        // 1. Validate: bounty exists
        // 2. Validate: msg.sender == bounty.creator
        // 3. Validate: block.timestamp > cancelLockUntil
        // 4. Validate: status == Open (no active evaluations)
        // 5. Update bounty status to Cancelled
        // 6. Process pending submissions:
        //    - Mark unprocessed submissions as void
        //    - Emit SubmissionRefunded for each
        // 7. Transfer ETH back to creator
        // 8. Emit BountyCancelled event
        
        revert("TODO: Implement cancelBounty");
    }

    /**
     * @notice Get bounty details
     * @param bountyId The bounty to query
     * @return Bounty struct
     */
    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        // TODO: Implement bounty getter
        // 1. Validate bounty exists
        // 2. Return bounties[bountyId]
        
        revert("TODO: Implement getBounty");
    }

    /**
     * @notice Get all submission IDs for a bounty
     * @param bountyId The bounty to query
     * @return Array of submission IDs
     */
    function getBountySubmissions(uint256 bountyId) external view returns (bytes32[] memory) {
        // TODO: Implement submission list getter
        // 1. Return bountySubmissions[bountyId]
        
        revert("TODO: Implement getBountySubmissions");
    }

    // ============================================================
    //                  SUBMISSION & EVALUATION
    // ============================================================

    /**
     * @notice Submit work and request Verdikta evaluation
     * @param bountyId The bounty to submit to
     * @param deliverableCid IPFS CID of the submission
     * @return submissionId Unique identifier for this submission
     * @dev Hunter must have approved LINK spend for evaluation fee
     */
    function submitAndEvaluate(
        uint256 bountyId,
        string calldata deliverableCid
    ) external nonReentrant returns (bytes32 submissionId) {
        // TODO: Implement submission and evaluation request
        // 1. Validate: bounty exists and status == Open
        // 2. Validate: deliverableCid is not empty
        // 3. Generate unique submissionId (keccak256 of bountyId, hunter, timestamp)
        // 4. Check hunter's LINK approval for this contract
        // 5. Build evaluation query package:
        //    - Create array: [rubricCid, deliverableCid]
        //    - Prepare evaluation query text
        // 6. Call verdiktaAggregator.requestAIEvaluationWithApproval()
        //    - Use bounty's classId
        //    - Use standard evaluation parameters (alpha, maxFee, etc.)
        // 7. Transfer LINK fee from hunter to this contract
        // 8. Create Submission struct
        // 9. Store submission and update mappings
        // 10. Update bounty status to Evaluating if first submission
        // 11. Emit SubmissionQueued event
        // 12. Return submissionId
        
        revert("TODO: Implement submitAndEvaluate");
    }

    /**
     * @notice Callback from Verdikta with evaluation result
     * @param verdiktaRequestId The Verdikta request ID
     * @param likelihoods Score array from Verdikta (outcome probabilities)
     * @param justificationCid IPFS CID of AI report
     * @dev Only callable by Verdikta Aggregator
     */
    function fulfillEvaluation(
        bytes32 verdiktaRequestId,
        uint256[] memory likelihoods,
        string memory justificationCid
    ) external nonReentrant {
        // TODO: Implement evaluation result processing
        // 1. Validate: msg.sender == address(verdiktaAggregator)
        // 2. Get submissionId from verdiktaRequestToSubmission mapping
        // 3. Validate submission exists and status == Evaluating
        // 4. Parse likelihoods to determine pass/fail:
        //    - likelihoods[0] = probability of PASS
        //    - likelihoods[1] = probability of FAIL
        //    - pass = likelihoods[0] >= 50
        // 5. Calculate score (0-100 scale)
        // 6. Update submission:
        //    - status = Passed or Failed
        //    - score = calculated score
        //    - reportCid = justificationCid
        // 7. If passed:
        //    - Update bounty status to Paid
        //    - Set bounty.winningSubmission
        //    - Transfer ETH to hunter
        //    - Emit BountyPaid event
        // 8. If failed:
        //    - Update bounty status back to Open if no other evaluations pending
        // 9. Emit EvaluationResult event
        
        revert("TODO: Implement fulfillEvaluation");
    }

    /**
     * @notice Mark evaluation as timed out (after 5 min) and refund hunter
     * @param submissionId The submission that timed out
     * @dev Anyone can call this after timeout period
     */
    function markEvaluationTimeout(bytes32 submissionId) external nonReentrant {
        // TODO: Implement timeout handling
        // 1. Validate: submission exists
        // 2. Validate: status == Evaluating
        // 3. Get timeout duration from Verdikta
        // 4. Validate: block.timestamp > submission.submittedAt + timeout
        // 5. Update submission status to TimedOut
        // 6. Update bounty status back to Open
        // 7. Call Verdikta's timeout finalization (if needed)
        // 8. Emit SubmissionRefunded event
        
        revert("TODO: Implement markEvaluationTimeout");
    }

    /**
     * @notice Get submission details
     * @param submissionId The submission to query
     * @return Submission struct
     */
    function getSubmission(bytes32 submissionId) external view returns (Submission memory) {
        // TODO: Implement submission getter
        // 1. Validate submission exists
        // 2. Return submissions[submissionId]
        
        revert("TODO: Implement getSubmission");
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Update Verdikta Aggregator address (owner only)
     * @param _newAggregator New Verdikta Aggregator address
     */
    function updateVerdiktaAggregator(address _newAggregator) external onlyOwner {
        require(_newAggregator != address(0), "Invalid address");
        address oldAddress = address(verdiktaAggregator);
        verdiktaAggregator = IVerdiktaAggregator(_newAggregator);
        emit VerdiktaAggregatorUpdated(oldAddress, _newAggregator);
    }

    /**
     * @notice Update LINK token address (owner only)
     * @param _newLinkToken New LINK token address
     */
    function updateLinkToken(address _newLinkToken) external onlyOwner {
        require(_newLinkToken != address(0), "Invalid address");
        address oldAddress = address(linkToken);
        linkToken = IERC20(_newLinkToken);
        emit LinkTokenUpdated(oldAddress, _newLinkToken);
    }

    // ============================================================
    //                      HELPER FUNCTIONS
    // ============================================================

    /**
     * @notice Check if a bounty can be cancelled
     * @param bountyId The bounty to check
     * @return canCancel Whether the bounty can be cancelled
     * @return reason Reason why it cannot be cancelled (if applicable)
     */
    function canCancelBounty(uint256 bountyId)
        external
        view
        returns (bool canCancel, string memory reason)
    {
        // TODO: Implement cancellation eligibility check
        // 1. Check if bounty exists
        // 2. Check if caller is creator
        // 3. Check if cancelLockUntil has passed
        // 4. Check if status is Open
        // 5. Return result and reason
        
        revert("TODO: Implement canCancelBounty");
    }

    /**
     * @notice Calculate LINK fee for evaluation
     * @param classId The Verdikta class ID
     * @return linkFee Amount of LINK tokens required
     */
    function calculateEvaluationFee(uint64 classId) external view returns (uint256 linkFee) {
        // TODO: Implement fee calculation
        // 1. Call verdiktaAggregator.maxTotalFee() with standard parameters
        // 2. Return calculated fee
        
        revert("TODO: Implement calculateEvaluationFee");
    }

    // ============================================================
    //                      RECEIVE FUNCTION
    // ============================================================

    /**
     * @notice Fallback function to reject direct ETH transfers
     * @dev ETH should only be sent via createBounty()
     */
    receive() external payable {
        revert("Use createBounty() to send ETH");
    }
}

