// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import {EvaluationWallet} from "./EvaluationWallet.sol";
import {BountyEscrowLens} from "./BountyEscrowLens.sol";
import {BountyRules} from "./BountyRules.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title BountyEscrow (v2 aggregator)
/// @notice Bounty escrow with four effective states: OPEN, EXPIRED, AWARDED, CLOSED
/// @dev No cancellation - creator can only reclaim funds after deadline via closeExpiredBounty
/// @dev Built on the v2 aggregator (verdikta-dispatcher `beacon` branch) and its TODO items:
///      - one aggregator, fixed at deployment, serving every jury size: each bounty carries its own
///        jury (K, M, N, P, timeout; item 15), passed with every request and fee quote;
///      - the creator's fee floor and beacon flag per bounty (items 8, 9);
///      - the two-phase round: drawJury (through the submission's wallet, so the draw reward comes
///        back to the funder) and promote, then the result; a dead round is closed with settle or
///        cancelUnsealed (closeFailedRound);
///      - the Q-of-N decision with a hunter bond and re-runs (item 12; see BountyRules): pass at Q,
///        hard fail below R (bond to the creator), and a soft fail or no result may re-run up to
///        MAX_ROUNDS rounds, each started within RERUN_WINDOW, keeping the submission's place.
///      Every per-bounty setting (jury, Q, R, bond, fee floor, beacons) is the creator's; the size-class
///      presets live in the website and API (example-bounty-program/shared/classPresets.js).
contract BountyEscrow {
    /// @notice On-chain storage states (3 values for gas efficiency)
    enum BountyStatus {
        Open,    // 0: Active (maps to OPEN or EXPIRED based on deadline)
        Awarded, // 1: Winner has been paid
        Closed   // 2: Deadline passed, funds returned to creator
    }

    enum SubmissionStatus {
        Prepared,               // 0: Wallet created, awaiting ETH funding and start
        PendingVerdikta,        // 1: Evaluation in progress
        Failed,                 // 2: Did not meet threshold
        PassedPaid,             // 3: Met threshold and was paid
        PassedUnpaid,           // 4: Met threshold but someone else already won
        PendingCreatorApproval, // 5: Awaiting creator approval during window
        AwaitingRerun           // 6: Soft fail or no result: may re-run (item 12), keeps its place
    }

    /// @notice Oracle request settings, chosen by the CREATOR at bounty creation and used
    ///         verbatim for every evaluation of that bounty. They shape the jury (who is
    ///         eligible and how selection is weighted) and size the hunter's prepay, so they
    ///         belong with the party whose money is at stake and are visible to hunters
    ///         before they commit work. Hunters supply nothing that reaches the aggregator
    ///         except their work CID.
    struct OracleParams {
        uint256 maxOracleFee;        // per-oracle fee ceiling (wei); arbiters priced above it are ineligible; sizes ethMaxBudget
        uint256 alpha;               // 0..1000, quality-vs-timeliness blend in arbiter selection
        uint256 estimatedBaseCost;   // wei, < maxOracleFee; price-boost baseline (0 disables the boost)
        uint256 maxFeeBasedScaling;  // x-factor >= 1 capping the price boost (1 disables it)
        uint256 minOracleFee;        // fee floor (wei, item 8): every juror (and beacon) is paid at least this; 0 = none
        bool    withBeacons;         // item 9's beacon flag (the Jumbo preset sets it)
    }

    /// @notice All inputs to createBounty, as one struct (avoids stack-too-deep and overload
    ///         ambiguity; extensible without a new signature).
    struct CreateParams {
        string  evaluationCid;               // evaluation package CID (bare CID, see _isValidCid)
        uint64  requestedClass;              // Verdikta class ID
        uint8   threshold;                   // 0..100 acceptance threshold
        uint64  submissionDeadline;          // unix seconds
        address targetHunter;                // address(0) = open to all
        uint256 creatorDeterminationPayment; // paid if the creator approves during the window
        uint256 arbiterDeterminationPayment; // paid if the oracle approves
        uint64  creatorAssessmentWindowSize; // seconds; 0 = no window (then the two payments must be equal)
        OracleParams oracle;
        IVerdiktaAggregator.Jury jury;       // the bounty's jury: K drawn, M promoted, N counted, P clustered, timeout (s)
        uint8   quota;                       // Q: a round passes with at least Q of its N scores >= threshold
        uint8   forfeitLine;                 // R <= Q: fewer than R scores >= threshold forfeits the bond
        uint256 bond;                        // wei the hunter (funder) posts at start; 0 = bondless
    }

    /// @dev Storage layout: fields are declared in ABI order but typed as narrowly as their
    ///      domain allows so that adjacent ones share a slot (15 slots in all). The jury is
    ///      stored flat (juryK..juryTimeout, the fields of CreateParams.jury) so it shares slot 14:
    ///      a nested struct would start a slot of its own.
    ///      Every integer still ABI-encodes as one 32-byte word, so an off-chain decoder
    ///      that declares these fields as uint256 keeps decoding them correctly. Bounds:
    ///      wei amounts fit uint128 (total ETH supply ~2^87 wei); timestamps fit uint64.
    struct Bounty {
        address creator;                      // slot 0
        string  evaluationCid;                // slot 1: IPFS CID for evaluation package (contains jury config, rubric ref, instructions)
        uint64  requestedClass;               // slot 2: Verdikta class ID
        uint8   threshold;                    // slot 2: 0..100 acceptance threshold
        uint128 payoutWei;                    // slot 2: ETH locked (max of two payment amounts)
        uint64  createdAt;                    // slot 3
        uint64  submissionDeadline;           // slot 3: Unix timestamp when submissions close
        BountyStatus status;                  // slot 3
        address winner;                       // slot 4
        uint64  submissions;                  // slot 4: count (every prepared submission, started or not)
        address targetHunter;                 // slot 5: address(0) = open to all, otherwise only this address can submit
        uint128 creatorDeterminationPayment;  // slot 6: Payment if creator approves
        uint128 arbiterDeterminationPayment;  // slot 6: Payment if arbiters approve via Verdikta
        uint64  creatorAssessmentWindowSize;  // slot 7: Window duration in seconds (0 = no window)
        OracleParams oracle;                  // slots 8-13: creator-chosen oracle request settings (also the createBounty input type — not narrowed)
        uint8   juryK;                        // slot 14: the jury (CreateParams.jury): K drawn
        uint8   juryM;                        // slot 14: M promoted
        uint8   juryN;                        // slot 14: N counted
        uint8   juryP;                        // slot 14: P clustered
        uint40  juryTimeout;                  // slot 14: round timeout (seconds, from the draw)
        uint8   quota;                        // slot 14: Q
        uint8   forfeitLine;                  // slot 14: R
        uint128 bond;                         // slot 14: hunter bond (wei)
    }

    /// @dev Same packing approach as Bounty: ABI order kept, types narrowed (6 slots instead
    ///      of 12). Everything prepare, start and finalize write besides the addresses and
    ///      the aggregation id sits in ONE slot (4), so each of them pays for it once.
    ///      ethMaxBudget is uint96 (max ~7.9e28 wei, ~660x the ETH supply): at start it equals
    ///      msg.value, and the prepare-time estimate is range-checked.
    ///      The result's justification CIDs are deliberately NOT stored here: the aggregator
    ///      keeps them permanently (read via getOracleResult / verdikta.getEvaluation) and the
    ///      SubmissionFinalized event carries them, so a third copy would only cost up to
    ///      ~250k gas per finalize.
    struct Submission {
        address hunter;             // slot 0: who prepared (and is paid the bounty if it wins)
        string  hunterCid;          // slot 1: Hunter's work product archive CID (bCID containing the actual submission)
        address evalWallet;         // slot 2
        bytes32 verdiktaAggId;      // slot 3: set once started
        SubmissionStatus status;    // slot 4
        uint8   acceptance;         // slot 4: stored acceptance (0..100)
        uint8   rejection;          // slot 4: stored rejection (0..100)
        uint64  submittedAt;        // slot 4
        uint64  finalizedAt;        // slot 4
        uint96  ethMaxBudget;       // slot 4: ETH wei prepay: maxTotalFee(...) ESTIMATE at prepare; the amount actually prepaid once started
        uint64  creatorWindowEnd;   // slot 5: Timestamp when creator window expires (0 if no window)
        address funder;             // slot 5: who funded the current (latest) round; receives its unspent refund
        address bondFunder;         // slot 6: who posted the bond at the first start; gets it back unless forfeited
        uint96  bondHeld;           // slot 6: the bond held (0 once returned or forfeited)
        uint64  rerunDeadline;      // slot 7: AwaitingRerun: the last second a re-run may start
        uint8   rounds;             // slot 7: rounds started (at most MAX_ROUNDS)
        uint8   passCount;          // slot 7: the last judged round's scores >= threshold (Q-of-N)
    }

    /// @notice The aggregator every bounty's rounds run on, fixed by the constructor. One deployment
    ///         serves every jury size (item 15): the jury is the bounty's, sent with each request.
    ///         Hunters' prepays only ever go to it.
    IVerdiktaAggregator public immutable aggregator;

    /// @notice The read-only extension of this contract (see BountyEscrowLens): the
    ///         convenience views that no longer fit in this bytecode — getSubmissions,
    ///         getBounties, getOracleResult, nextAction, prepareCutoff, canBeClosed,
    ///         isAcceptingSubmissions, getEffectiveBountyStatus, startValue. They are still callable AT
    ///         THIS ADDRESS with the merged ABI (see fallback); this getter only exists so a
    ///         block explorer or a curious caller can find the verified lens source.
    ///         Created once, in the constructor. No setter, no owner, no upgrade path.
    BountyEscrowLens public immutable lens;

    /// @notice The EvaluationWallet implementation every submission's wallet is a minimal-proxy
    ///         clone of (EIP-1167). Created once, in the constructor; its immutables (bountyContract,
    ///         this, and the aggregator) are shared by all clones. Informational — nothing ever
    ///         operates the implementation itself.
    EvaluationWallet public immutable walletImplementation;

    Bounty[] public bounties;
    mapping(uint256 => Submission[]) public subs;

    /// @notice Pull-payment ledger. ETH owed to an address whose direct payment couldn't be
    ///         delivered (e.g. a contract that rejects ETH). Lets resolution/close-out never
    ///         revert on a hostile or incompatible recipient. Claim via withdraw().
    mapping(address => uint256) public withdrawable;

    /// @notice The PENDING LIST: per bounty, the ids of the submissions that hold payout
    ///         priority: in evaluation (PendingVerdikta) or between rounds (AwaitingRerun).
    ///         Pushed at start, swap-removed when the submission resolves for good, so at every
    ///         moment it holds exactly those submissions and nothing else. Every scan that must look at in-flight
    ///         evaluations (_requireNoPassingSubmission at start, _hasEarlierPendingByOther
    ///         at payout) iterates THIS list, never the full submissions array — so
    ///         never-started, gas-only prepares cost those scans nothing, however many there
    ///         are, and closeExpiredBounty checks "no active evaluation" in O(1) via its
    ///         length. Bounded by MAX_ACTIVE_EVALUATIONS. Read via activeEvaluations() and
    ///         pendingSubmissionIds().
    mapping(uint256 => uint256[]) private _pending;
    /// @dev bountyId => submissionId => index in _pending[bountyId]; meaningful only while
    ///      that submission is pending.
    mapping(uint256 => mapping(uint256 => uint256)) private _pendingPos;
    /// @dev bountyId => submissions with a round in flight (PendingVerdikta): what
    ///      MAX_ACTIVE_EVALUATIONS caps. AwaitingRerun entries are on the pending list but not here,
    ///      so a blocked bounty does not fill its slots (item 12).
    mapping(uint256 => uint256) private _inFlight;

    /// @notice Cap on CONCURRENT rounds per bounty (rounds in flight, not the pending list).
    /// @dev Bounds the start-time scan (_requireNoPassingSubmission): each round in flight that
    ///      already has a result is judged with the Q-of-N rule, which reads every counted
    ///      arbiter's score — ~160k gas per sibling on a Jumbo jury (27 reveals, measured
    ///      2026-11-23 on the mock), so ~10M at the cap, under the 16.8M per-transaction cap the
    ///      aggregator is sized for (v1's 256 at ~20k each would now be ~41M). Siblings without a
    ///      result cost ~20k, and AwaitingRerun entries one storage read. The payout-priority scan
    ///      at finalize only reads each sibling's hunter (~2k gas each). Unlike a cap
    ///      on PREPARED submissions, a slot here is never free: starting an evaluation
    ///      prepays the oracle round, whose per-arbiter base fees are consumed at dispatch
    ///      and never refunded, and the slot is released as soon as the round resolves
    ///      (result, or closeFailedRound — both callable by anyone). Keeping
    ///      a bounty full therefore costs real ETH every response-timeout period rather than
    ///      a one-off few dollars of gas. startPreparedSubmission reverts
    ///      "evaluation slots full - retry later" while the bounty is at the cap; nothing
    ///      else is affected (prepare, finalize, closeFailedRound and close all still work).
    ///      Counts rounds in flight only, not submissions awaiting a re-run.
    uint256 public constant MAX_ACTIVE_EVALUATIONS = 64;

    /// @notice Item 12's re-run limits: at most MAX_ROUNDS rounds per submission (the first plus 5
    ///         re-runs), each re-run started within RERUN_WINDOW of the previous round resolving and
    ///         before the submission deadline. Otherwise the submission fails with its bond returned.
    uint256 public constant MAX_ROUNDS = 6;
    uint256 public constant RERUN_WINDOW = 2 hours;

    /// @notice Cap on PREPARED submissions (in any state) per bounty — WINDOWED bounties ONLY.
    /// @dev Windowed bounties order submissions by index and honour an earlier submission's
    ///      still-open creator window (_hasEarlierUnresolvedSubmission). Those in-window
    ///      entries are gas-only to create yet must be scanned, so on windowed bounties that
    ///      scan is bounded the direct way: by capping prepares (~7k gas per never-started
    ///      entry, measured — three cold slots each; ~0.9M gas at the cap). On a TARGETED windowed bounty
    ///      only the target can prepare, so the cap can only ever be self-inflicted. On an
    ///      OPEN windowed bounty anyone can fill it for gas alone and shut other hunters out
    ///      until the deadline — a known, accepted weakness of that unusual configuration;
    ///      target the bounty or drop the window if it matters. NON-WINDOWED bounties have
    ///      NO prepare cap: their scans use the pending list, so junk prepares cost them
    ///      nothing on-chain (off-chain indexers should page with getSubmissionsPage). A full
    ///      windowed bounty only rejects NEW prepares; existing submissions still resolve
    ///      and the creator can still close at the deadline.
    uint256 public constant MAX_SUBMISSIONS_PER_BOUNTY = 128;

    /// @notice Accepted length range for CID strings (evaluation package and work product).
    /// @dev CIDv0 is exactly 46 chars; base32 CIDv1 is typically 59. The upper bound matches
    ///      the aggregator's own MAX_CID_LENGTH. See _isValidCid for the character rule.
    uint256 public constant MIN_CID_LENGTH = 46;
    uint256 public constant MAX_CID_LENGTH = 100;

    /// @notice Bounds on creator-chosen oracle settings, checked at createBounty so a bad
    ///         bounty fails at creation instead of stranding hunters at start time.
    /// @dev The aggregator/keeper themselves require estimatedBaseCost < maxFee and
    ///      scaling >= 1, clamp maxFee to the aggregator ceiling, and would panic on
    ///      alpha > 1000 or overflow on an astronomically large scaling factor.
    uint256 public constant MAX_ALPHA = 1000;
    uint256 public constant MAX_FEE_SCALING_FACTOR = 1000;

    /// @notice The addendum text forwarded to the aggregator: always empty.
    /// @dev It is appended to the query the arbiters see — a free-text channel into the
    ///      prompt. The creator's evaluation package is the whole query; nothing else may
    ///      be added by either party.
    string public constant ADDENDUM = "";

    /// @notice Score semantics. Each arbiter's FUND score is on 0..SCORE_SCALE (outcome 1 of
    ///         [DONT_FUND, FUND]; any other result shape is no result); the threshold is
    ///         0..100, so a score counts when score >= threshold x SCORE_DIVISOR. See BountyRules —
    ///         the single interpreter used by finalize, the sibling scans and the lens.
    uint256 public constant SCORE_SCALE = BountyRules.SCORE_SCALE;
    uint256 public constant SCORE_DIVISOR = BountyRules.SCORE_DIVISOR;

    /// @notice Gas forwarded to a recipient when the escrow pays out directly (_payOrCredit).
    /// @dev Payouts, refunds and bounty closes send ETH with `call{gas: PAYOUT_GAS_LIMIT}`.
    ///      Capping it makes settlement cost independent of the recipient: a contract that
    ///      burns everything it is given can only burn the cap, instead of forcing whoever
    ///      finalizes to bring ~64x the remaining work (EIP-150), and a callback gets too
    ///      little gas to do anything interesting. Ordinary wallets and simple smart-contract
    ///      wallets are paid directly; a recipient that needs more, or fails, is credited to
    ///      `withdrawable` and claims via withdraw() with full gas, exactly as a recipient
    ///      that rejects ETH is today. Deliberately a constant: this contract has no owner.
    uint256 public constant PAYOUT_GAS_LIMIT = 120_000;

    /// @notice Gas forwarded to the EvaluationWallet for the INLINE prepay recovery at the end
    ///         of finalizeSubmission / closeFailedRound (wallet → aggregator withdrawEth →
    ///         wallet → escrow). Measured cost of that path is ~30k against the mock and well
    ///         under 100k against the live aggregator; 200k leaves ample headroom.
    /// @dev Why cap a call into our own wallet: the wallet forwards into the aggregator, and
    ///      the inline recovery is wrapped in try/catch precisely so resolution never depends
    ///      on that path. Without a cap, an aggregator withdraw that burned gas would leave
    ///      the transaction only 1/64 of its budget after the catch (EIP-150) — possibly not
    ///      enough to emit RefundDeferred and return — so the whole resolution would revert
    ///      anyway. With the cap, the worst case is a bounded amount of wasted gas and a
    ///      deferred refund. The retry path, recoverLeftoverEth(), forwards full gas.
    uint256 public constant INLINE_REFUND_GAS_LIMIT = 200_000;

    // Non-reentrancy guard (1 = unlocked, 2 = locked).
    uint256 private _lock = 1;

    // ----------------- Events -----------------
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        string evaluationCid,
        uint64 classId,
        uint8 threshold,
        uint256 payoutWei,
        uint64 submissionDeadline
    );

    event BountyClosed(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amountReturned
    );

    // FIELD ORDER MATTERS: static fields first, the dynamic string LAST.
    // Earlier revisions emitted `string evaluationCid` before `ethMaxBudget`. Because a
    // dynamic field is encoded as an offset word (96 / 0x60) with the bytes appended
    // later, any consumer decoding the log with a truncated or misordered ABI (e.g. a
    // naive `(address,uint256)`) read 96 as the budget and under-funded the start tx.
    // With the string last, even that naive decode reads evalWallet and ethMaxBudget
    // correctly.
    //
    // !! This is an EVENT-SIGNATURE CHANGE relative to the contracts deployed before
    // !! September 2026. It must be deployed together with every off-chain ABI copy
    // !! that decodes this event (server/utils/contractService.js,
    // !! server/routes/jobRoutes.js BUNDLE_ESCROW_ABI, server/scripts/submitToBounties.js,
    // !! client/src/services/contractService.js, client/src/pages/Blockchain.jsx), plus
    // !! a config.deploymentBlock bump and a sync reset. Anything that still reads the
    // !! OLD contract's logs must keep the old field order for that address.
    event SubmissionPrepared(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        address indexed hunter,
        address evalWallet,
        uint256 ethMaxBudget,
        string evaluationCid
    );

    event WorkSubmitted(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        bytes32 verdiktaAggId
    );

    /// @param passed  the oracle result met the threshold (or the creator approved)
    /// @param paid    the bounty was awarded to this submission in this transaction
    ///                (false for Failed, PassedUnpaid, and TIMED_OUT)
    event SubmissionFinalized(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        bool passed,
        bool paid,
        uint256 acceptance,
        uint256 rejection,
        string justificationCids
    );

    event PayoutSent(
        uint256 indexed bountyId,
        address indexed winner,
        uint256 amountWei
    );

    event EthRefunded(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        uint256 amount
    );

    /// @notice The inline recovery of a submission's unspent oracle prepay failed; the
    ///         resolution itself succeeded. Anyone may retry with recoverLeftoverEth().
    event RefundDeferred(uint256 indexed bountyId, uint256 indexed submissionId);

    event CreatorApproved(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        address indexed hunter,
        uint256 amountPaid
    );

    event CreatorRefunded(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 amountRefunded
    );

    /// @notice A direct payment couldn't be delivered and was credited to the pull ledger instead.
    event PaymentDeferred(address indexed to, uint256 amount);

    /// @notice An address claimed its pull-ledger balance.
    event Withdrawn(address indexed account, uint256 amount);

    /// @notice A round ended in a soft fail or with no result (item 12): the submission keeps its
    ///         place and bond and may re-run until `rerunDeadline` (rerunSubmission).
    /// @param noResult the round produced no usable result (failed, cancelled or malformed)
    event RerunAwaited(
        uint256 indexed bountyId,
        uint256 indexed submissionId,
        uint8 round,
        uint256 passCount,
        bool noResult,
        uint64 rerunDeadline
    );

    /// @notice The hunter bond went back to its funder (pass, or any exit that is not a hard fail).
    event BondReturned(uint256 indexed bountyId, uint256 indexed submissionId, address indexed to, uint256 amount);

    /// @notice A hard fail (fewer than R scores at the threshold): the bond went to the creator.
    event BondForfeited(uint256 indexed bountyId, uint256 indexed submissionId, address indexed creator, uint256 amount);

    /// @param aggregator_ the aggregator (fixed for life)
    constructor(IVerdiktaAggregator aggregator_) {
        require(address(aggregator_) != address(0), "zero addr");
        aggregator = aggregator_;
        // The lens's creation code lives in THIS contract's initcode (its own, larger,
        // EIP-3860 budget), not in the runtime bytecode that EIP-170 caps.
        lens = new BountyEscrowLens();
        walletImplementation = new EvaluationWallet(address(this), aggregator_);
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------- Bounty lifecycle -------------

    /// @notice Create a bounty with ETH escrow.
    /// @dev msg.value must equal max(creatorDeterminationPayment, arbiterDeterminationPayment).
    ///      For a bounty without a creator window pass both payments equal to msg.value.
    ///      The oracle settings are validated here (see OracleParams / MAX_* bounds) and used
    ///      verbatim for every evaluation of this bounty; hunters cannot change them.
    function createBounty(CreateParams calldata p) external payable returns (uint256 bountyId) {
        require(p.creatorDeterminationPayment > 0, "no creator payment");
        require(p.arbiterDeterminationPayment > 0, "no arbiter payment");
        require(
            msg.value == _max(p.creatorDeterminationPayment, p.arbiterDeterminationPayment),
            "ETH must equal max payment"
        );
        require(_isValidCid(p.evaluationCid), "bad evaluationCid");
        require(p.threshold <= 100, "bad threshold");
        require(p.submissionDeadline > block.timestamp, "deadline in past");
        require(
            p.creatorAssessmentWindowSize > 0 ||
                p.creatorDeterminationPayment == p.arbiterDeterminationPayment,
            "window required when payments differ"
        );

        // Oracle settings: reject anything the aggregator/keeper would reject at start.
        // The jury: the aggregator's structural rules (AggregatorLib.checkJury: K >= M >= N >= P >= 1,
        // 2M > K, N <= 40, P >= 2 unless N = 1), so a bad jury is
        // refused here rather than at the first start. Its live limits (maxJury, the keeper's
        // shortlist, T+ < timeout <= maxTimeout) are owner-set and checked by each request.
        IVerdiktaAggregator.Jury memory j = p.jury;
        require(
            j.P != 0 && j.P <= j.N && j.N <= j.M && j.M <= j.K && 2 * uint256(j.M) > j.K && j.N <= 40 &&
                (j.P != 1 || j.N == 1),
            "bad jury"
        );
        IVerdiktaAggregator agg = aggregator;
        OracleParams calldata o = p.oracle;
        require(o.maxOracleFee > 0, "bad oracle fee");
        require(o.maxOracleFee <= agg.maxOracleFee(), "oracle fee above ceiling");
        require(o.estimatedBaseCost < o.maxOracleFee, "base cost must be below fee");
        require(o.maxFeeBasedScaling >= 1 && o.maxFeeBasedScaling <= MAX_FEE_SCALING_FACTOR, "bad fee scaling");
        require(o.alpha <= MAX_ALPHA, "bad alpha");
        // The floor may exceed the ceiling (it prices jurors, not eligibility); the aggregator
        // stores it as uint96.
        require(o.minOracleFee <= type(uint96).max, "bad fee floor");
        // Item 12's decision rule: R <= Q <= N (the bounty's own N, fixed with it).
        require(p.quota >= 1 && p.forfeitLine <= p.quota && p.quota <= j.N, "bad quota");
        require(p.bond <= type(uint96).max, "bad bond");

        // The uint128 casts are safe: msg.value == max(payments), so both payments and the
        // escrowed amount are bounded by the ETH actually sent (far below 2^128 wei).
        bounties.push(Bounty({
            creator: msg.sender,
            evaluationCid: p.evaluationCid,
            requestedClass: p.requestedClass,
            threshold: p.threshold,
            payoutWei: uint128(msg.value),
            createdAt: uint64(block.timestamp),
            submissionDeadline: p.submissionDeadline,
            status: BountyStatus.Open,
            winner: address(0),
            submissions: 0,
            targetHunter: p.targetHunter,
            creatorDeterminationPayment: uint128(p.creatorDeterminationPayment),
            arbiterDeterminationPayment: uint128(p.arbiterDeterminationPayment),
            creatorAssessmentWindowSize: p.creatorAssessmentWindowSize,
            oracle: o,
            juryK: j.K,
            juryM: j.M,
            juryN: j.N,
            juryP: j.P,
            juryTimeout: j.timeout,
            quota: p.quota,
            forfeitLine: p.forfeitLine,
            bond: uint128(p.bond)
        }));

        bountyId = bounties.length - 1;
        // The budget, quoted from the stored bounty (its oracle settings are already within the
        // ceiling, so the effective ones are the creator's). maxTotalFee reverts if beacons are
        // asked for and the aggregator has none.
        uint256 budget = _prepay(bounties[bountyId]);
        require(budget > 0 && budget <= type(uint88).max, "bad budget");
        emit BountyCreated(
            bountyId,
            msg.sender,
            p.evaluationCid,
            p.requestedClass,
            p.threshold,
            msg.value,
            p.submissionDeadline
        );
    }

    /// @notice Close an expired bounty and return funds to creator
    /// @dev Can be called by ANYONE after submissionDeadline passes
    /// @dev Requires no active evaluations (PendingVerdikta submissions)
    /// @dev Safe to call at the deadline: prepare and start both require block.timestamp
    ///      to be before the deadline, so no submission can enter evaluation afterwards.
    ///      Only an evaluation already in flight (PendingVerdikta) blocks closing.
    /// @param bountyId The bounty to close
    function closeExpiredBounty(uint256 bountyId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        require(b.status == BountyStatus.Open, "bounty not open");
        require(block.timestamp >= b.submissionDeadline, "deadline not passed");

        // No submission may be in evaluation or awaiting a re-run (O(1) — the pending list is empty).
        require(_pending[bountyId].length == 0, "active evaluation - finalize first");

        // All clear - return funds to creator
        b.status = BountyStatus.Closed;
        uint256 amt = b.payoutWei;
        b.payoutWei = 0;

        emit BountyClosed(bountyId, b.creator, amt);
        _payOrCredit(b.creator, amt);
    }

    // ------------- Submissions & Verdikta -------------

    /// @notice STEP 1: Prepare a submission. Deploys an EvaluationWallet and records the work.
    /// @dev The emitted ethMaxBudget is the aggregator's maxTotalFee for the BOUNTY's oracle fee
    ///      at prepare time — an ESTIMATE of what to attach at start. startPreparedSubmission
    ///      recomputes it live (see requiredPrepay()); every submission to a bounty prepays the
    ///      same amount at any given moment.
    /// @dev If the bounty has a creator assessment window, status starts as PendingCreatorApproval.
    ///      Otherwise, status starts as Prepared (classic behavior).
    /// @dev Can only be called before the submission deadline. On windowed bounties the
    ///      effective cutoff is earlier: the creator window must end before the deadline.
    /// @dev The oracle request is built entirely from the bounty (evaluation package, class,
    ///      creator-chosen oracle settings) plus an empty addendum; the hunter supplies only
    ///      their work CID.
    /// @param bountyId The bounty to submit to
    /// @param evaluationCid The evaluation package CID — must match the bounty's (a guard that
    ///        the caller is submitting against the package they think they are)
    /// @param hunterCid The hunter's work product archive CID (bare CID, see _isValidCid)
    function prepareSubmission(
        uint256 bountyId,
        string calldata evaluationCid,
        string calldata hunterCid
    ) external returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget) {
        return _prepareSubmission(bountyId, evaluationCid, hunterCid);
    }

    function _prepareSubmission(
        uint256 bountyId,
        string calldata evaluationCid,
        string calldata hunterCid
    ) internal returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget) {
        Bounty storage b = _mustBounty(bountyId);
        require(b.status == BountyStatus.Open, "bounty not open");
        require(block.timestamp < b.submissionDeadline, "deadline passed");
        if (b.targetHunter != address(0)) {
            require(msg.sender == b.targetHunter, "bounty is targeted");
        }
        // The bounty's evaluationCid was validated at creation; the mismatch check below
        // covers the caller's copy. The work-product CID is hunter-supplied free text and
        // MUST be a bare CID (see _isValidCid).
        require(_isValidCid(hunterCid), "bad hunterCid");
        // Windowed bounties only — see MAX_SUBMISSIONS_PER_BOUNTY. Non-windowed bounties
        // are unbounded here; their scans never touch never-started submissions.
        if (b.creatorAssessmentWindowSize > 0) {
            require(subs[bountyId].length < MAX_SUBMISSIONS_PER_BOUNTY, "submission limit reached");
        }

        // Verify evaluationCid matches the bounty's stored evaluationCid
        require(
            keccak256(bytes(evaluationCid)) == keccak256(bytes(b.evaluationCid)),
            "evaluationCid mismatch"
        );

        ethMaxBudget = _prepay(b);
        require(ethMaxBudget > 0 && ethMaxBudget <= type(uint96).max, "bad budget");

        // EIP-1167 clone of the shared implementation: ~40k gas instead of a ~390k deployment.
        address wallet = Clones.clone(address(walletImplementation));

        uint64 window = b.creatorAssessmentWindowSize;
        bool hasWindow = window > 0;

        // Windowed bounties: the deadline is the last moment for the hunter to have their
        // evaluation STARTED (see startPreparedSubmission), and starting is only allowed
        // strictly after the creator window ends. So the window must end early enough to
        // leave at least one second in which the hunter can start. Otherwise the submission
        // could never be arbitrated and the deadline-based close would be unsafe.
        if (hasWindow) {
            require(
                block.timestamp + window + 1 < b.submissionDeadline,
                "window would end after deadline"
            );
        }

        // Push an empty struct and assign only the non-zero fields (writing zeros to fresh
        // slots would cost gas for nothing). Prepared == 0 needs no write.
        Submission[] storage list = subs[bountyId];
        Submission storage s = list.push();
        s.hunter = msg.sender;
        s.hunterCid = hunterCid;
        s.evalWallet = wallet;
        s.submittedAt = uint64(block.timestamp);
        s.ethMaxBudget = uint96(ethMaxBudget); // range-checked above
        if (hasWindow) {
            s.status = SubmissionStatus.PendingCreatorApproval;
            s.creatorWindowEnd = uint64(block.timestamp) + window;
        }

        submissionId = list.length - 1;
        b.submissions += 1;

        emit SubmissionPrepared(
            bountyId,
            submissionId,
            msg.sender,
            wallet,
            ethMaxBudget,
            evaluationCid
        );

        evalWallet = wallet;
    }

    /// @notice Creator approves a submission during the assessment window
    /// @dev Pays creatorDeterminationPayment to hunter, refunds excess to creator
    /// @dev Blocked while an earlier submission still holds priority: another hunter's in
    ///      evaluation or in its own open window, or the SAME hunter's in evaluation (their
    ///      live claim to the arbiter rate) — see _hasEarlierUnresolvedSubmission
    function creatorApproveSubmission(uint256 bountyId, uint256 submissionId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(msg.sender == b.creator, "only creator");
        require(b.status == BountyStatus.Open, "bounty not open");
        require(s.status == SubmissionStatus.PendingCreatorApproval, "not pending creator approval");
        require(block.timestamp <= s.creatorWindowEnd, "window expired");
        require(
            !_hasEarlierUnresolvedSubmission(bountyId, submissionId),
            "earlier submission unresolved"
        );

        uint256 pay = b.creatorDeterminationPayment;
        uint256 refund = b.payoutWei - pay;

        b.payoutWei = 0;
        b.status = BountyStatus.Awarded;
        b.winner = s.hunter;
        s.status = SubmissionStatus.PassedPaid;
        s.finalizedAt = uint64(block.timestamp);

        emit CreatorApproved(bountyId, submissionId, s.hunter, pay);
        emit PayoutSent(bountyId, s.hunter, pay);
        _payOrCredit(s.hunter, pay);

        if (refund > 0) {
            emit CreatorRefunded(bountyId, b.creator, refund);
            _payOrCredit(b.creator, refund);
        }
    }

    /// @notice STEP 2: Fund and start the Verdikta evaluation by attaching ETH.
    /// @dev The caller attaches msg.value == startValue(bountyId): the round's prepay
    ///      (requiredPrepay) plus the bounty's hunter bond. The prepay goes to the EvaluationWallet,
    ///      which escrows it with the aggregator; the bond stays here until the submission resolves
    ///      (returned to the caller unless a hard fail forfeits it to the creator). No ERC20 approval.
    /// @dev For Prepared submissions (no window): only the hunter can call.
    /// @dev For PendingCreatorApproval submissions (window expired): anyone can call and fund.
    /// @dev Must be called BEFORE the submission deadline. Everything the hunter has to do
    ///      (prepare, wait out any creator window, start) happens before the deadline, so at
    ///      the deadline every submission is either paid, in evaluation (or awaiting a re-run),
    ///      or dead. That is what makes closeExpiredBounty's check sufficient.
    /// @dev Reverts if any in-flight submission has already passed evaluation (it, or an
    ///      earlier one, will be paid — see _hasEarlierPendingByOther)
    /// @dev The round still has to be drawn: drawJury(bountyId, submissionId), by anyone, from two
    ///      blocks after this one (twice for a beacon bounty).
    function startPreparedSubmission(uint256 bountyId, uint256 submissionId) external payable nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);

        require(b.status == BountyStatus.Open, "bounty not open");

        bool fromCreatorWindow = s.status == SubmissionStatus.PendingCreatorApproval;

        if (fromCreatorWindow) {
            // After window expires, anyone can start arbitration and fund the evaluation
            require(block.timestamp > s.creatorWindowEnd, "creator window still open");
        } else {
            require(s.status == SubmissionStatus.Prepared, "already started or resolved");
            require(msg.sender == s.hunter, "only hunter");
        }

        uint256 bond = b.bond;
        require(msg.value >= bond, "wrong eth amount");
        s.bondFunder = msg.sender;
        s.bondHeld = uint96(bond);           // bounded at createBounty
        _addPending(bountyId, submissionId);
        _startRound(b, s, bountyId, submissionId, msg.value - bond);
    }

    /// @notice Draw the jury of a submission's current round, as its requester (the wallet), so the
    ///         draw reward comes back to the round's funder with the leftover. Anyone may call, from
    ///         two blocks after the round started; a beacon bounty needs a second call once the beacon
    ///         values are in (the first starts the beacon stage). The aggregator's own checks apply
    ///         (TooEarly, WrongPhase, DrawExpired after a day).
    function drawJury(uint256 bountyId, uint256 submissionId) external nonReentrant {
        _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(s.status == SubmissionStatus.PendingVerdikta, "not pending");
        EvaluationWallet(payable(s.evalWallet)).drawJury();
    }

    /// @notice Finalize a submission's round by reading its Verdikta result (item 12's Q-of-N rule).
    /// @dev Pass (>= Q scores at the threshold): paid if the bounty is still Open and this
    ///      submission holds priority; the bond is returned. Soft fail (R..Q-1) or a malformed
    ///      result: AwaitingRerun (or Failed with the bond returned once no re-run is possible).
    ///      Hard fail (< R): Failed, the bond goes to the creator. The round's unspent prepay
    ///      goes back to its funder in every case.
    /// @dev PAYOUT PRIORITY (both bounty kinds): by submission index among submissions holding
    ///      priority (in evaluation or awaiting a re-run). A passing submission is paid only once
    ///      every lower-index one by another hunter has resolved; until then this call reverts
    ///      "earlier submission pending - retry after it resolves" (a retry, not a failure —
    ///      the result is kept). See _hasEarlierPendingByOther for why.
    /// @dev Can be called even after deadline (for submissions made before deadline)
    function finalizeSubmission(uint256 bountyId, uint256 submissionId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(s.status == SubmissionStatus.PendingVerdikta, "not pending");

        BountyRules.Verdict memory v = BountyRules.judge(
            aggregator, s.verdiktaAggId, b.threshold, b.quota, b.forfeitLine
        );
        if (!v.hasResult) {
            // A round that ended with no result at all is closed by closeFailedRound (which also
            // settles or cancels it on the aggregator); a result of the wrong shape is handled here.
            require(v.outcome == BountyRules.Outcome.NotReady, "no oracle result - use closeFailedRound");
            revert("Verdikta not ready");
        }

        // Leaving evaluation (every branch below changes the status).
        _inFlight[bountyId] -= 1;
        s.acceptance = uint8(v.acceptance);   // 0..100 by construction (BountyRules)
        s.rejection  = uint8(v.rejection);
        s.passCount = uint8(v.passCount);
        s.finalizedAt = uint64(block.timestamp);

        if (v.outcome == BountyRules.Outcome.Pass) {
            _removePending(bountyId, submissionId);
            bool paid = false;
            if (b.status == BountyStatus.Open) {
                // Pay only with priority. If a lower-index submission by another hunter still holds
                // priority, REVERT rather than writing a terminal status: this one stays
                // PendingVerdikta (the changes above are rolled back) and finalize is retried once
                // the earlier one resolves. It always resolves: a result, a failed round
                // (closeFailedRound), or an expired re-run (expireRerun) — all permissionless.
                require(
                    !_hasEarlierPendingByOther(bountyId, submissionId),
                    "earlier submission pending - retry after it resolves"
                );
                uint256 pay = b.arbiterDeterminationPayment;
                uint256 refund = b.payoutWei - pay;
                b.payoutWei = 0;
                b.status = BountyStatus.Awarded;
                b.winner = s.hunter;
                s.status = SubmissionStatus.PassedPaid;
                paid = true;
                emit SubmissionFinalized(bountyId, submissionId, true, true, v.acceptance, v.rejection, v.justificationCids);
                emit PayoutSent(bountyId, s.hunter, pay);
                _payOrCredit(s.hunter, pay);
                if (refund > 0) {
                    emit CreatorRefunded(bountyId, b.creator, refund);
                    _payOrCredit(b.creator, refund);
                }
            } else {
                s.status = SubmissionStatus.PassedUnpaid;      // bounty already awarded or closed
                emit SubmissionFinalized(bountyId, submissionId, true, false, v.acceptance, v.rejection, v.justificationCids);
            }
            _returnBond(bountyId, submissionId);
        } else if (v.outcome == BountyRules.Outcome.HardFail) {
            _removePending(bountyId, submissionId);
            s.status = SubmissionStatus.Failed;
            emit SubmissionFinalized(bountyId, submissionId, false, false, v.acceptance, v.rejection, v.justificationCids);
            uint256 bond = s.bondHeld;
            if (bond > 0) {
                s.bondHeld = 0;
                emit BondForfeited(bountyId, submissionId, b.creator, bond);
                _payOrCredit(b.creator, bond);
            }
        } else {
            // SoftFail, or a result of an unexpected shape (NoResult)
            _awaitRerun(b, s, bountyId, submissionId, v.outcome == BountyRules.Outcome.NoResult, v.justificationCids);
        }
        _refundLeftoverEth(bountyId, submissionId);
    }

    /// @notice Close a submission's round that ended, or must end, with no result: settle it on the
    ///         aggregator if its deadline has passed, or cancel it if it can never be drawn, then
    ///         move the submission on. Anyone may call.
    /// @dev The gate is the AGGREGATOR's state, not a local timer:
    ///      - a round with a result reverts "result available - use finalizeSubmission", so a
    ///        passing score can never be discarded by a third party;
    ///      - a round still open (not failed or cancelled after the attempts below) reverts
    ///        "round still open": failing it now would strand its prepay on the aggregator.
    ///      No result is not the hunter's fault (too few commits or reveals, a missed beacon quorum,
    ///      a round nobody drew), so the submission keeps its place and bond: AwaitingRerun, or
    ///      Failed with the bond returned once no re-run is possible. Some of these rounds send the
    ///      unspent prepay to the committers or the aggregator's arbiter pool rather than back (a
    ///      refund would be a free re-roll); whatever came back is returned to the funder.
    function closeFailedRound(uint256 bountyId, uint256 submissionId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(s.status == SubmissionStatus.PendingVerdikta, "not pending");
        IVerdiktaAggregator agg = aggregator;
        bytes32 aggId = s.verdiktaAggId;

        // Best effort: each reverts when it does not apply (NotDue, WrongPhase, TooEarly).
        try agg.settle(aggId) {} catch { /* ignore */ }
        try agg.cancelUnsealed(aggId) {} catch { /* ignore */ }

        (, , bool ok) = agg.getEvaluation(aggId);
        require(!ok, "result available - use finalizeSubmission");
        (uint8 phase, , , , , , , , , , , ) = agg.getRoundInfo(aggId);
        require(phase == BountyRules.PH_FAILED || phase == BountyRules.PH_CANCELLED, "round still open");

        _inFlight[bountyId] -= 1;
        s.acceptance = 0;
        s.rejection = 0;
        s.passCount = 0;
        s.finalizedAt = uint64(block.timestamp);
        _awaitRerun(b, s, bountyId, submissionId, true, "");
        _refundLeftoverEth(bountyId, submissionId);
    }

    /// @notice Re-run a submission that soft-failed or got no result (item 12): a new round with a
    ///         fresh jury, from the same wallet, keeping the submission's index (payout priority) and
    ///         its bond. Attach msg.value == requiredPrepay(bountyId). The hunter or the bond's
    ///         funder may call, until rerunDeadline, before the submission deadline, while the
    ///         bounty is Open and fewer than MAX_ROUNDS rounds have run. A re-run never reopens a
    ///         creator window. Draw it with drawJury like the first round.
    function rerunSubmission(uint256 bountyId, uint256 submissionId) external payable nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(s.status == SubmissionStatus.AwaitingRerun, "not awaiting rerun");
        require(msg.sender == s.hunter || msg.sender == s.bondFunder, "only hunter or funder");
        require(b.status == BountyStatus.Open, "bounty not open");
        require(block.timestamp <= s.rerunDeadline, "rerun window closed");
        require(s.rounds < MAX_ROUNDS, "rerun limit reached");
        _startRound(b, s, bountyId, submissionId, msg.value);
    }

    /// @notice Fail a submission whose re-run window has closed (or that can no longer re-run: the
    ///         bounty is no longer Open, or the deadline has passed), returning its bond. Anyone
    ///         may call; it frees the submission's place in the payout queue.
    function expireRerun(uint256 bountyId, uint256 submissionId) external nonReentrant {
        Bounty storage b = _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(s.status == SubmissionStatus.AwaitingRerun, "not awaiting rerun");
        require(
            block.timestamp > s.rerunDeadline || b.status != BountyStatus.Open ||
                block.timestamp >= b.submissionDeadline,
            "rerun window open"
        );
        _removePending(bountyId, submissionId);
        s.status = SubmissionStatus.Failed;
        emit SubmissionFinalized(bountyId, submissionId, false, false, s.acceptance, s.rejection, "RERUN_EXPIRED");
        _returnBond(bountyId, submissionId);
    }

    /// @notice Claim ETH credited to you on the pull-payment ledger (a payout, refund, or
    ///         creator reclaim whose direct delivery failed). Pays msg.sender.
    function withdraw() external nonReentrant {
        uint256 amt = withdrawable[msg.sender];
        require(amt > 0, "nothing to withdraw");
        withdrawable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        require(ok, "withdraw failed");
        emit Withdrawn(msg.sender, amt);
    }

    // ------------- Views -------------

    function bountyCount() external view returns (uint256) {
        return bounties.length;
    }

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        return _mustBounty(bountyId);
    }

    function submissionCount(uint256 bountyId) external view returns (uint256) {
        return subs[bountyId].length;
    }

    function getSubmission(uint256 bountyId, uint256 submissionId)
        external view returns (Submission memory)
    {
        return _mustSubmission(bountyId, submissionId);
    }

    /// @notice Number of submissions with a round in flight (PendingVerdikta) for a bounty, O(1):
    ///         what MAX_ACTIVE_EVALUATIONS caps. closeExpiredBounty requires the pending list
    ///         (which also holds AwaitingRerun submissions) to be empty.
    function activeEvaluations(uint256 bountyId) external view returns (uint256) {
        return _inFlight[bountyId];
    }

    /// @notice The submission ids holding payout priority (PendingVerdikta and AwaitingRerun), in
    ///         LIST order — not submission order; swap-removal reorders it.
    function pendingSubmissionIds(uint256 bountyId) external view returns (uint256[] memory) {
        return _pending[bountyId];
    }

    /// @notice One round's prepay (wei) for this bounty RIGHT NOW: the aggregator's
    ///         maxTotalFee for the bounty's fee ceiling (clamped), fee floor and beacon flag.
    ///         Identical for every submission to the bounty. Attach it to rerunSubmission; a first
    ///         start attaches startValue (this plus the bond). The ethMaxBudget in
    ///         SubmissionPrepared is the same figure at prepare time — an estimate.
    function requiredPrepay(uint256 bountyId) external view returns (uint256) {
        return _prepay(_mustBounty(bountyId));
    }

    /// @notice The oracle settings that startPreparedSubmission will actually forward RIGHT NOW.
    /// @dev Upstream configuration policy: the aggregator's fee ceiling, bonus multiplier and
    ///      rewards are owner-settable and may change after a bounty is created (the jury and its
    ///      timeout are the bounty's, fixed with it). Creation validates the creator's settings against the
    ///      ceiling of that moment only. At start the escrow reads the live ceiling and CLAMPS:
    ///        - maxOracleFee     → min(bounty fee, current ceiling)  (the aggregator does this
    ///                             itself; mirrored here so the quote and the keeper agree)
    ///        - estimatedBaseCost → lowered to (effective fee − 1) if it no longer sits below
    ///                             the effective fee (the keeper requires base < fee; without
    ///                             this a lowered ceiling would make every start revert and
    ///                             strand prepared submissions)
    ///        - alpha, maxFeeBasedScaling, the fee floor, beacons → unchanged
    ///      requiredPrepay() is quoted from the effective fee.
    function effectiveOracleParams(uint256 bountyId) external view returns (OracleParams memory) {
        return _effectiveOracle(_mustBounty(bountyId));
    }

    function _effectiveOracle(Bounty storage b) internal view returns (OracleParams memory o) {
        o = b.oracle;
        uint256 ceiling = aggregator.maxOracleFee();
        if (o.maxOracleFee > ceiling) o.maxOracleFee = ceiling;
        if (o.estimatedBaseCost >= o.maxOracleFee) {
            o.estimatedBaseCost = o.maxOracleFee > 0 ? o.maxOracleFee - 1 : 0;
        }
    }

    // ------------- Internals -------------

    function _prepay(Bounty storage b) internal view returns (uint256) {
        return _quote(b, _effectiveOracle(b));
    }

    /// @dev The aggregator's maxTotalFee for the bounty's jury and the (effective) oracle settings `o`.
    function _quote(Bounty storage b, OracleParams memory o) internal view returns (uint256) {
        return aggregator.maxTotalFee(o.maxOracleFee, o.minOracleFee, o.withBeacons, b.juryK, b.juryP);
    }

    /// @dev The bounty's jury, as the aggregator takes it.
    function _jury(Bounty storage b) internal view returns (IVerdiktaAggregator.Jury memory) {
        return IVerdiktaAggregator.Jury(b.juryK, b.juryM, b.juryN, b.juryP, b.juryTimeout);
    }

    /// @dev Start a round (first start or re-run): checks, the prepay through the wallet, and the
    ///      submission's new state. `prepay` is the ETH for the aggregator (the bond is held apart).
    function _startRound(
        Bounty storage b,
        Submission storage s,
        uint256 bountyId,
        uint256 submissionId,
        uint256 prepay
    ) private {
        require(block.timestamp < b.submissionDeadline, "deadline passed");
        // Bounded concurrency — see MAX_ACTIVE_EVALUATIONS. Slots free up as rounds resolve.
        require(_inFlight[bountyId] < MAX_ACTIVE_EVALUATIONS, "evaluation slots full - retry later");
        // If an in-flight round has already passed, it (or an earlier one) will be paid: a new
        // round could never win and would only waste its prepay. A RE-RUN keeps its index, so
        // only a LOWER-index pass can beat it: a later passing round still waits for it at
        // finalize (_hasEarlierPendingByOther), and the re-run is the remedy it was promised.
        _requireNoPassingSubmission(bountyId, b, s.rounds > 0 ? submissionId : type(uint256).max);
        // Q <= N was checked at create against the bounty's own jury, which never changes.

        // The requirement is recomputed HERE from the bounty's fee policy: the aggregator's
        // maxTotalFee depends on owner-settable parameters (fee ceiling, bonus multiplier,
        // rewards), so any earlier figure is only an estimate. Checking against the live value
        // means a parameter change can never strand a prepared submission.
        OracleParams memory o = _effectiveOracle(b);   // clamped to the aggregator's live ceiling
        uint256 required = _quote(b, o);
        require(required > 0, "bad budget");
        require(prepay == required, "wrong eth amount");
        s.ethMaxBudget = uint96(required); // what this round prepaid (== the value, so it fits)

        // A previous round's deferred refund goes to ITS funder before this round's funder is set
        // (best effort: if this retry fails too, what it would have returned goes to the new funder).
        if (s.rounds > 0) _refundLeftoverEth(bountyId, submissionId);

        // CID array for Verdikta:
        // cids[0] = Evaluation package (jury config, rubric reference via 'additional', instructions)
        // cids[1] = Hunter's work product (bCID containing the actual submission to evaluate)
        string[] memory cids = new string[](2);
        cids[0] = b.evaluationCid;
        cids[1] = s.hunterCid;

        bytes32 aggId = EvaluationWallet(payable(s.evalWallet)).startEvaluation{value: prepay}(
            cids,
            EvaluationWallet.Request(
                ADDENDUM, o.alpha, o.maxOracleFee, o.minOracleFee, o.estimatedBaseCost,
                o.maxFeeBasedScaling, b.requestedClass, o.withBeacons, _jury(b)
            )
        );

        s.funder = msg.sender;
        s.verdiktaAggId = aggId;
        s.rounds += 1;
        s.rerunDeadline = 0;
        s.status = SubmissionStatus.PendingVerdikta;
        _inFlight[bountyId] += 1;

        emit WorkSubmitted(bountyId, submissionId, aggId);
    }

    /// @dev A soft fail or no result (item 12): AwaitingRerun while a re-run is still possible
    ///      (bounty Open, rounds left, time before the deadline), else Failed with the bond returned.
    ///      The submission stays on the pending list (it keeps payout priority) until then.
    function _awaitRerun(
        Bounty storage b,
        Submission storage s,
        uint256 bountyId,
        uint256 submissionId,
        bool noResult,
        string memory justificationCids
    ) private {
        uint256 until = block.timestamp + RERUN_WINDOW;
        if (until >= b.submissionDeadline) until = uint256(b.submissionDeadline) - 1;
        if (b.status == BountyStatus.Open && s.rounds < MAX_ROUNDS && until >= block.timestamp) {
            s.status = SubmissionStatus.AwaitingRerun;
            s.rerunDeadline = uint64(until);
            emit RerunAwaited(bountyId, submissionId, s.rounds, s.passCount, noResult, uint64(until));
            return;
        }
        _removePending(bountyId, submissionId);
        s.status = SubmissionStatus.Failed;
        emit SubmissionFinalized(
            bountyId, submissionId, false, false, s.acceptance, s.rejection,
            noResult && bytes(justificationCids).length == 0 ? "NO_RESULT" : justificationCids
        );
        _returnBond(bountyId, submissionId);
    }

    function _returnBond(uint256 bountyId, uint256 submissionId) private {
        Submission storage s = subs[bountyId][submissionId];
        uint256 bond = s.bondHeld;
        if (bond == 0) return;
        s.bondHeld = 0;
        emit BondReturned(bountyId, submissionId, s.bondFunder, bond);
        _payOrCredit(s.bondFunder, bond);
    }

    /// @dev Pending-list maintenance (see _pending). O(1) each; the list holds exactly the
    ///      PendingVerdikta submissions of the bounty.
    function _addPending(uint256 bountyId, uint256 submissionId) private {
        _pendingPos[bountyId][submissionId] = _pending[bountyId].length;
        _pending[bountyId].push(submissionId);
    }

    function _removePending(uint256 bountyId, uint256 submissionId) private {
        uint256[] storage list = _pending[bountyId];
        uint256 i = _pendingPos[bountyId][submissionId];
        uint256 last = list.length - 1;
        if (i != last) {
            uint256 moved = list[last];
            list[i] = moved;
            _pendingPos[bountyId][moved] = i;
        }
        list.pop();
        delete _pendingPos[bountyId][submissionId];
    }

    /// @dev Check that no in-flight round has already passed (item 12's Q-of-N rule): that one
    ///      (or an even earlier one) will be paid, so a new, higher-index round could never win
    ///      and would only waste its prepay. Scans the PENDING LIST and queries the aggregator for
    ///      each round in flight, since results aren't stored until finalization. AwaitingRerun
    ///      entries have no live round; never-started submissions are not on the list.
    ///      Only passes at an index below `below` count: type(uint256).max for a first start (any
    ///      pass beats a new, higher-index submission), the submission's own index for a re-run
    ///      (a higher-index pass cannot beat it, since payout follows index).
    function _requireNoPassingSubmission(uint256 bountyId, Bounty storage b, uint256 below) internal view {
        uint256[] storage pending = _pending[bountyId];
        Submission[] storage list = subs[bountyId];
        IVerdiktaAggregator agg = aggregator;
        uint256 n = pending.length;

        for (uint256 i = 0; i < n; ) {
            uint256 pid = pending[i];
            Submission storage e = list[pid];
            if (pid < below && e.status == SubmissionStatus.PendingVerdikta &&
                BountyRules.passes(agg, e.verdiktaAggId, b.threshold, b.quota, b.forfeitLine)) {
                revert("another submission already passed - finalize it first");
            }
            unchecked { ++i; }
        }
    }

    /// @dev PAYOUT PRIORITY, both bounty kinds: is a LOWER-index submission by ANOTHER hunter
    ///      still in evaluation? Walks the pending list (see _pending); no aggregator call.
    ///
    ///      Why index, not "first to complete": the work CID is public from the moment
    ///      prepareSubmission lands, so on an open bounty anyone can prepare + start a copy
    ///      of it at a higher index. Two oracle rounds over identical content complete in
    ///      random order; "first to complete wins" would hand the copier the bounty about
    ///      half the time (more, with several copies). Index priority makes the earlier
    ///      submitter win whenever their own round passes: a later passing submission waits
    ///      (finalize reverts, retryable) until every earlier in-flight submission by someone
    ///      else has resolved, and if one of those passes it takes the bounty first. The
    ///      wait is bounded: a dead round is closed by anyone (closeFailedRound), and a
    ///      submission awaiting a re-run (which keeps its priority, item 12) re-runs within
    ///      RERUN_WINDOW or is expired by anyone (expireRerun), at most MAX_ROUNDS times. Once a round
    ///      passes, _requireNoPassingSubmission refuses every first start and every re-run of a
    ///      HIGHER index; an earlier submission awaiting a re-run may still re-run (it never left
    ///      the pending list, so the later pass was already waiting for it). Before that, starts need not follow index order: an
    ///      earlier prepared submission that starts late takes priority over a later one in flight
    ///      (its CID, and so its index, was public first).
    ///
    ///      Only submissions IN EVALUATION hold priority. A prepared-but-unstarted
    ///      submission holds none (it may never be funded), so a hunter must start promptly
    ///      after preparing — the website / bundle flow does both back to back. Residual
    ///      exposure: if the original's own round fails or times out, a copy can still win.
    ///
    ///      Same-hunter earlier siblings never block (both would pay the same address at the
    ///      same rate, so paying the later one first harms nobody), and resolved siblings
    ///      are not on the list. Order-independent: whoever calls finalize, and in whatever
    ///      order, the same submission is paid.
    function _hasEarlierPendingByOther(uint256 bountyId, uint256 submissionId)
        internal view returns (bool)
    {
        uint256[] storage pending = _pending[bountyId];
        Submission[] storage list = subs[bountyId];
        address hunter = list[submissionId].hunter;
        uint256 n = pending.length;

        for (uint256 i = 0; i < n; ) {
            uint256 id = pending[i];
            if (id < submissionId && list[id].hunter != hunter) return true;
            unchecked { ++i; }
        }
        return false;
    }

    /// @dev CREATOR-APPROVAL priority (windowed bounties): does any earlier submission (lower
    ///      index) still hold a claim that approving `submissionId` at the creator rate would
    ///      extinguish? Scans the FULL submissions array (it must see in-window, never-started
    ///      entries), which is why windowed bounties keep a cap on prepared submissions
    ///      (MAX_SUBMISSIONS_PER_BOUNTY). Payout priority at finalize uses the pending-list
    ///      rule in _hasEarlierPendingByOther instead — at finalize time no earlier window
    ///      can still be open (windows end in index order and a submission can only start
    ///      after its own window ends), so the rules below apply to creator approval only.
    ///      An earlier submission blocks approval while it can still win:
    ///        - PendingVerdikta, ANY hunter: an oracle evaluation is in flight. For another
    ///          hunter that is their live claim; for the SAME hunter it is their live,
    ///          paid-for claim to the arbiter rate — possibly already passing on the
    ///          aggregator — and letting the creator approve a newer version for the
    ///          (possibly far smaller) creator rate would extinguish it: the bounty becomes
    ///          Awarded and the earlier version finalizes to PassedUnpaid. The creator may
    ///          approve the newer version once the earlier one has resolved (if it failed).
    ///          Temporary either way — evaluations always resolve.
    ///        - PendingCreatorApproval by ANOTHER hunter with its window still OPEN: the
    ///          creator may still approve it. Bounded by the window length.
    ///      It does NOT block when:
    ///        - Its window expired and nobody started arbitration. Preparing costs only gas
    ///          and nobody is obliged to fund it, so such a submission would otherwise stay
    ///          "unresolved" forever and lock out every later submission for free.
    ///        - It belongs to the SAME hunter and is sitting in its window. A hunter who
    ///          resubmits is choosing the later version; the usual windowed flow is a
    ///          targeted bounty where every submission is theirs, and the creator must be
    ///          able to approve the revision without anyone paying to arbitrate the stale one.
    function _hasEarlierUnresolvedSubmission(uint256 bountyId, uint256 submissionId)
        internal view returns (bool)
    {
        Submission[] storage list = subs[bountyId];
        address hunter = list[submissionId].hunter;
        for (uint256 i = 0; i < submissionId; ) {
            Submission storage e = list[i];
            SubmissionStatus st = e.status;
            if (st == SubmissionStatus.PendingVerdikta || st == SubmissionStatus.AwaitingRerun) return true;
            if (e.hunter != hunter &&
                st == SubmissionStatus.PendingCreatorApproval &&
                block.timestamp <= e.creatorWindowEnd) {
                return true;
            }
            unchecked { ++i; }
        }
        return false;
    }

    /// @dev Try to send `amount` to `to` with at most PAYOUT_GAS_LIMIT gas. If the direct
    ///      send fails (a contract that rejects ETH, or one that needs / burns more gas than
    ///      the cap), credit it to the pull-payment ledger instead of reverting — so a
    ///      hostile or incompatible recipient can never brick payout, refund, or bounty close,
    ///      nor dictate how much gas the caller must bring.
    ///      Callers MUST update all contract state before calling this (checks-effects-interactions).
    function _payOrCredit(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount, gas: PAYOUT_GAS_LIMIT}("");
        if (!ok) {
            withdrawable[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }

    /// @dev Best-effort inline recovery of the unspent oracle prepay (and the draw reward), run
    ///      when a round resolves (finalizeSubmission / closeFailedRound) and before a re-run. The wallet pulls its ethOwed credit
    ///      from the aggregator and hands its balance back to THIS contract, which routes it
    ///      to whoever funded the start (Submission.funder).
    ///
    ///      Resolution must NOT depend on this succeeding: the chain wallet -> aggregator
    ///      withdrawEth -> wallet -> escrow is an external dependency, and if it ever reverted
    ///      (an aggregator upgrade, a paused withdrawal, a changed accounting rule) an
    ///      un-wrapped call would leave the submission stuck in PendingVerdikta, pin
    ///      activeEvaluations, and lock the bounty. So the call is wrapped: on failure the
    ///      status change and payout stand, RefundDeferred is emitted, and anyone can retry
    ///      later with recoverLeftoverEth(). In the common case the funder is refunded here,
    ///      in the same transaction, exactly as before.
    function _refundLeftoverEth(uint256 bountyId, uint256 submissionId) private {
        Submission storage s = subs[bountyId][submissionId];
        try EvaluationWallet(payable(s.evalWallet)).refundLeftoverEth{gas: INLINE_REFUND_GAS_LIMIT}() returns (uint256 refunded) {
            emit EthRefunded(bountyId, submissionId, refunded);
            _payOrCredit(s.funder, refunded);
        } catch {
            emit RefundDeferred(bountyId, submissionId);
        }
    }

    /// @notice Retry recovery of a resolved submission's unspent oracle prepay and pay it to
    ///         the address that funded the start. Anyone may call.
    /// @dev Only for submissions whose round has resolved (Failed / PassedPaid / PassedUnpaid /
    ///      AwaitingRerun) — while a round is open the prepay is still reserved on the
    ///      aggregator and there is nothing to recover. The wallet's refundLeftoverEth() is
    ///      idempotent (pull any ethOwed credit, sweep the wallet balance), so this also
    ///      recovers ETH that reaches the wallet AFTER resolution. Reverts from the wallet or
    ///      aggregator are NOT swallowed here, so a caller can see why a retry failed.
    function recoverLeftoverEth(uint256 bountyId, uint256 submissionId) external nonReentrant {
        _mustBounty(bountyId);
        Submission storage s = _mustSubmission(bountyId, submissionId);
        require(
            s.status == SubmissionStatus.Failed ||
            s.status == SubmissionStatus.PassedPaid ||
            s.status == SubmissionStatus.PassedUnpaid ||
            s.status == SubmissionStatus.AwaitingRerun,
            "not resolved"
        );
        require(s.funder != address(0), "never started");
        uint256 refunded = EvaluationWallet(payable(s.evalWallet)).refundLeftoverEth();
        require(refunded > 0, "nothing to recover");
        emit EthRefunded(bountyId, submissionId, refunded);
        _payOrCredit(s.funder, refunded);
    }

    /// @dev Shape check for an IPFS CID string. Accepts CIDv0 (46 base58 chars, "Qm…") and
    ///      base32 CIDv1 ("b…", lowercase a-z / 2-7), i.e. anything alphanumeric of a
    ///      plausible length; rejects everything else.
    ///
    ///      WHY THIS MATTERS: the aggregator only length-checks CIDs and then serializes the
    ///      request as a delimiter-based payload — "1:<cid0>,<cid1>:<addendum>" — for the
    ///      oracle nodes to parse. A hunter-supplied "CID" containing ',' would smuggle extra
    ///      archives into the evaluation, and one containing ':' would smuggle an addendum,
    ///      re-opening the prompt channel this contract deliberately keeps empty
    ///      (ADDENDUM). Validating here keeps every CID a bare content reference all
    ///      the way through parsing, regardless of how a node splits the payload.
    function _isValidCid(string calldata cid) internal pure returns (bool) {
        bytes calldata b = bytes(cid);
        uint256 len = b.length;
        if (len < MIN_CID_LENGTH || len > MAX_CID_LENGTH) return false;
        for (uint256 i = 0; i < len; ) {
            uint8 c = uint8(b[i]);
            unchecked {
                // 0-9: c-0x30 < 10; A-Z / a-z: fold case with |0x20, then (c|0x20)-0x61 < 26.
                // Wrap-around on subtraction makes every other byte (incl. /:@[\`{ and >=0x80)
                // fail both tests.
                bool ok = (c - 0x30 < 10) || ((c | 0x20) - 0x61 < 26);
                if (!ok) return false;
                ++i;
            }
        }
        return true;
    }

    function _mustBounty(uint256 bountyId) internal view returns (Bounty storage) {
        require(bountyId < bounties.length, "bad bountyId");
        return bounties[bountyId];
    }

    function _mustSubmission(uint256 bountyId, uint256 submissionId)
        internal view returns (Submission storage)
    {
        require(submissionId < subs[bountyId].length, "bad submissionId");
        return subs[bountyId][submissionId];
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ------------- Read-only extension (lens) -------------

    /// @dev Any selector this contract does not implement is answered by the lens AT THIS
    ///      ADDRESS, so callers keep one address and one (merged) ABI and cannot tell the two
    ///      contracts apart. Mechanism: a STATICCALL into lensDelegate(), which delegatecalls
    ///      the lens. The STATICCALL frame makes the EVM itself reject any state change
    ///      (SSTORE, LOG, CALL with value, CREATE, SELFDESTRUCT) inside the lens, so this can
    ///      never become a write path — the lens is trusted for nothing. Return data and
    ///      revert data are copied back verbatim, so a lens view reverting "bad bountyId"
    ///      surfaces exactly as if this contract had reverted. This is NOT a proxy: `lens` is
    ///      an immutable with no setter, and this contract has no owner. Non-payable: ETH
    ///      sent with unknown calldata reverts (plain transfers still land in receive()).
    fallback() external {
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(this.lensDelegate.selector, msg.data)
        );
        // memory-safe: only reads `ret` (Solidity-allocated) and terminates.
        assembly ("memory-safe") {
            let p := add(ret, 32)
            let n := mload(ret)
            if iszero(ok) { revert(p, n) }
            return(p, n)
        }
    }

    /// @notice Plumbing for the fallback above — NOT for external use. Reverts "self only"
    ///         for every caller but this contract. It is in the ABI only because the
    ///         STATICCALL guard needs an external entry point; it is reachable solely inside
    ///         a static frame, so despite its non-view signature it cannot change state.
    function lensDelegate(bytes calldata data) external {
        require(msg.sender == address(this), "self only");
        address target = address(lens);
        // memory-safe: scratch is placed at the free memory pointer and the block terminates
        // (return/revert) without touching anything Solidity allocated.
        assembly ("memory-safe") {
            let p := mload(0x40)
            calldatacopy(p, data.offset, data.length)
            let ok := delegatecall(gas(), target, p, data.length, 0, 0)
            returndatacopy(p, 0, returndatasize())
            if iszero(ok) { revert(p, returndatasize()) }
            return(p, returndatasize())
        }
    }

    receive() external payable {}
}
