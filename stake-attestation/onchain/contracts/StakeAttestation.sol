// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IVerdiktaAggregator} from "./interfaces/IVerdiktaAggregator.sol";
import {EvaluationWallet} from "./EvaluationWallet.sol";
import {StakeAttestationLens} from "./StakeAttestationLens.sol";
import {ClaimLogic} from "./libraries/ClaimLogic.sol";
import {ClaimRules} from "./libraries/ClaimRules.sol";

/// @title StakeAttestation
/// @notice A maker stakes an award table behind one version of an artifact (a repository at a
///         commit, or a deployed contract built from one). Hunters who prove a bug in it commit
///         an encrypted proof, the maker gets a fix window, and the Verdikta arbiters judge the
///         revealed proof; a valid finding is paid from the escrow. Every listing, claim and
///         verdict is on-chain, so the record of a version is public. The record is a statement
///         of what was staked and what the arbiters found, never a guarantee.
///         Design: verdikta-arbiter docs/development/stake-attestation-design.md, §13. The
///         build plan's errata, assumptions and decisions (stake-attestation/docs/BUILD_PLAN.md)
///         override it where they differ.
/// @dev    Built in nodes. P2a: list, fund, renew, close, the listing fee, the pull ledger and
///         the listing views. P2b (this revision adds it): the claim lifecycle up to the
///         evaluation request: commit (two hashes, erratum E5), disclose, flagBadDisclosure,
///         release, rollForward, reveal (the request, §13.3 with errata E1-E3) and expire. Later
///         nodes extend the types and bookkeeping declared here:
///         - P2c: finalize by polling, settlement under THRESHOLD, Depleted and owedWei. Its
///           settle marks a claim Settled and calls ClaimLogic.resolve (which keeps
///           pendingClaims and the commit-order queue true), and pushes a valid claim onto
///           _validFindings.
///         - P2d: dispute, failed rounds (a RoundFailed claim; a failed submission already
///           enters it here), re-trigger, leftover recovery. P2e: late claims and recordByHash.
///         close() refuses while pendingClaims or owedWei is non-zero (decision D8).
///
///         Size (EIP-170): the claim functions' bodies are the linked library ClaimLogic, and
///         derived views (claim state, deadlines, quotes) live in StakeAttestationLens, served at
///         this address through the fallback as BountyEscrow's are. Later nodes follow suit.
///
///         Program values are fixed per deployment (assumption A5): the window bounds, the
///         listing period, THRESHOLD, the payout gas cap. The contract owner has exactly two
///         powers, the listing fee and its recipient, and both apply from the next fund or
///         renew; the owner has no path to any escrow, bond, prepay, pull balance, threshold or
///         listing's terms. Badge labels (scanned, staked, under-staked, invited) and their
///         floors are computed off-chain from the record.
///
///         Every outgoing transfer goes through _payOrCredit (gas-capped, falling back to the
///         pull ledger) or withdraw(). ETH-moving entry points are non-reentrant.
contract StakeAttestation is Ownable2Step {
    // ------------------------------------------------------------------
    //                               types
    // ------------------------------------------------------------------

    /// @notice Listed after list; Open once funded (escrow >= the top award, fee paid);
    ///         Depleted when a payout leaves the escrow below the top award (P2c); Rolled once a
    ///         successor is named (P2b); Closed after close. Order is ABI: append only.
    enum ListingState { Listed, Open, Depleted, Rolled, Closed }

    /// @notice The six outcomes of a claim, in the order of the jury's vector (design §8.7).
    ///         A severity class is LOW..CRITICAL; awards[] is indexed by class - LOW.
    enum Outcome { INVALID, DUPLICATE, LOW, MEDIUM, HIGH, CRITICAL }

    /// @notice What the stake is bound to (design §8.8). `skill` follows its harness image in a
    ///         later phase; append it here then.
    enum ArtifactKind { Repo, Contract }

    /// @notice The artifact's identity. Its hash is the record's key (artifactHashOf).
    struct Artifact {
        ArtifactKind kind;
        string  repo;        // https URL, printable ASCII, at most MAX_REPO_LENGTH bytes
        string  baseCommit;  // full commit hash: 40 or 64 lowercase hex characters
        uint64  chainId;     // Contract only (0 for Repo)
        address addr;        // Contract only: the deployment (address(0) for Repo)
    }

    /// @notice Oracle request settings, chosen by the MAKER at listing and used verbatim for
    ///         every evaluation of the listing, as BountyEscrow's are for a bounty: they shape the
    ///         jury and size the hunter's prepay, so hunters see them before they commit.
    struct OracleParams {
        uint64  requestedClass;      // Verdikta class ID (the code classes, decision D1)
        uint256 maxOracleFee;        // per-oracle fee ceiling (wei) for a claim's evaluation
        uint256 disputeMaxOracleFee; // per-oracle fee ceiling (wei) for the dispute panel
        uint256 estimatedBaseCost;   // wei, below both fees; price-boost baseline (0 disables it)
        uint256 alpha;               // 0..MAX_ALPHA, quality-vs-timeliness blend in selection
        uint256 maxFeeBasedScaling;  // 1..MAX_FEE_SCALING_FACTOR, caps the price boost (1 disables it)
    }

    /// @notice Everything list() takes besides the archives and the known issues.
    ///         Windows are in seconds.
    struct ListParams {
        Artifact artifact;
        bytes32  disclosureKey;      // the maker's X25519 disclosure public key (the 32 bytes an age1 recipient encodes)
        uint256[4] awards;           // wei, by class: [LOW, MEDIUM, HIGH, CRITICAL]
        Outcome  lowestClassCounted; // LOW..CRITICAL
        uint256  bondWei;            // the hunter's bond per claim
        uint32   fixWindow;          // <= MAX_FIX_WINDOW; 0 allowed
        uint32   disputeWindow;      // MIN_DISPUTE_WINDOW..MAX_WINDOW
        uint32   disclosureGrace;    // <= fixWindow
        uint32   revealWindow;       // MIN_REVEAL_WINDOW..MAX_WINDOW
        address[] allowlist;         // empty = open to every hunter; else "invited"
        uint256  valueAtRiskUsd;     // declared, whole dollars; 0 = not declared
        OracleParams oracle;
    }

    /// @notice One staked version of one artifact (design §13.1). Terms are fixed at list();
    ///         the escrow, the fee period, the state and the claim bookkeeping change after.
    /// @dev Field order packs the small fields into three slots; P2b-P2e append fields at the end.
    struct Listing {
        // slot 0
        address maker;
        ListingState state;
        ArtifactKind artifactKind;
        Outcome lowestClassCounted;
        uint64  listedAt;
        // slot 1
        uint64  openedAt;            // first fund that opened it (0 while Listed)
        uint64  fundedUntil;         // end of the paid listing period (0 while Listed)
        uint32  fixWindow;
        uint32  disputeWindow;
        uint32  disclosureGrace;
        uint32  revealWindow;
        // slot 2
        address artifactAddress;
        uint64  artifactChainId;
        // terms
        bytes32 artifactHash;
        bytes32 disclosureKey;
        string  listingCid;          // the evaluation archive (cids[0] of a claim's request)
        string  disputeCid;          // the dispute archive (cids[0] of a dispute request)
        uint256[4] awards;
        uint256 bondWei;
        uint256 valueAtRiskUsd;
        bytes32[] knownIssueIds;     // strictly ascending, fixed at listing (design §8.4)
        address[] allowlist;
        OracleParams oracle;
        // money and bookkeeping
        uint256 escrowWei;           // what awards are paid from; never includes a fee
        uint256 owedWei;             // award shortfall still owed to hunters (P2c)
        uint256 pendingClaims;       // claims neither settled nor expired (P2b)
        uint256 predecessor;         // listing id this version fixed (0 = none; P2b)
        uint256 successor;           // listing id that fixed this one (0 = none; P2b)
        // the commit-order queue (P2b, decision D5): the unresolved claims, oldest first, as a
        // doubly linked list through Claim.prevInOrder / nextInOrder, so resolving any claim is
        // O(1) and "every earlier claim is settled or expired" is `headClaim == claimId`.
        uint64  rolledAt;            // when rollForward named the successor (0 = not rolled)
        uint64  headClaim;           // the earliest claim neither settled nor expired (0 = none)
        uint64  tailClaim;           // the latest such claim
        uint64  headSince;           // when headClaim became the earliest: its reveal clock's floor
        // counts for the record (P2b)
        uint64  claimsCommitted;     // every claim ever committed here
        uint64  undisclosedClaims;   // expired without a disclosure (erratum E5)
        uint64  unrevealedClaims;    // expired without a reveal (design decision 15)
    }

    /// @notice A claim's life (design §13.1, erratum E5, decision D5). Order is ABI: append only.
    ///         Stored: Committed, then Revealed (request submitted) or RoundFailed (the
    ///         submission failed and the prepay is held; P2d re-triggers), or Expired. P2c
    ///         adds Judged and Settled, P2d Disputed. Revealable is never stored: a fix window
    ///         ends by time, by release or by a roll-forward of the whole listing, so the lens
    ///         derives it (claimState).
    enum ClaimState { Committed, Revealable, Revealed, Judged, Disputed, Settled, Expired, RoundFailed }

    /// @notice Why a claim expired. The listing counts each (undisclosedClaims, unrevealedClaims).
    enum Expiry { None, Undisclosed, Unrevealed }

    /// @notice One hunter's claim against one listing (design §13.1 with erratum E5).
    /// @dev Field order packs the small fields into five slots; P2c-P2e append fields at the end.
    ///      bondWei and prepayWei are uint128: each is at most what one transaction carried.
    struct Claim {
        // slot 0
        address hunter;
        uint64  committedAt;         // fixes the claim's place in commit order (design §8.7)
        ClaimState state;
        Expiry  expiry;
        bool    flaggedBadDisclosure;
        bool    released;            // the maker waived the fix window
        // slot 1
        uint64  listingId;
        uint64  disclosedAt;         // 0 = not disclosed; the fix window and the grace run from it
        uint64  fixWindowEnd;        // disclosedAt + fixWindow, or the release time
        uint64  revealedAt;
        // slot 2
        uint64  prevInOrder;         // the commit-order queue (Listing.headClaim); 0 once resolved
        uint64  nextInOrder;
        bytes16 contentKey;          // age's file key, from the reveal (erratum E1)
        // slot 3
        address evalWallet;          // the reveal's EvaluationWallet clone
        bool    disclosedAfterRoll;  // disclosed after the listing rolled forward: own fix window
        // slot 4
        uint128 bondWei;
        uint128 prepayWei;           // held for the evaluation; topped up at reveal (erratum E3)
        // commitments, reveal and request
        bytes32 archiveHash;         // sha256 of the plaintext archive
        bytes32 ciphertextSha256;    // sha256 of the archive encrypted to the disclosure key
        bytes32 ephemeralKey;        // the X25519 ephemeral secret, from the reveal (erratum E1)
        bytes32 requestId;           // the aggregator's id for the reveal's request (0 if it failed)
        string  ciphertextCid;       // from disclose
        string  bcid;                // the plaintext archive, from the reveal
    }

    // ------------------------------------------------------------------
    //                     program values (fixed per deployment)
    // ------------------------------------------------------------------

    /// @notice The jury's vector sums to SCORE_SCALE; settlement uses THRESHOLD, a strict
    ///         majority (design §8.7, T = 500,001). Constants: no setter exists.
    uint256 public constant SCORE_SCALE = 1_000_000;
    uint256 public constant THRESHOLD = 500_001;

    /// @notice One listing fee buys this much live listing (fund opens it, renew extends it).
    uint256 public constant LISTING_PERIOD = 30 days;

    /// @notice Window bounds, decision D8: revealWindow >= 72 h, disputeWindow >= 24 h,
    ///         disclosureGrace <= fixWindow, fixWindow <= 90 d (0 allowed). MAX_WINDOW applies
    ///         the fix window's ceiling to the reveal and dispute windows too, so no term a maker
    ///         sets can hold a hunter's bond or award, or block later claims, indefinitely.
    uint256 public constant MIN_REVEAL_WINDOW = 72 hours;
    uint256 public constant MIN_DISPUTE_WINDOW = 24 hours;
    uint256 public constant MAX_FIX_WINDOW = 90 days;
    uint256 public constant MAX_WINDOW = 90 days;

    /// @notice Bounds on the per-listing arrays, which list() writes to storage one word each.
    uint256 public constant MAX_KNOWN_ISSUES = 256;
    uint256 public constant MAX_ALLOWLIST = 64;

    /// @notice Accepted length range for CID strings, as BountyEscrow's (see _isValidCid).
    uint256 public constant MIN_CID_LENGTH = 46;
    uint256 public constant MAX_CID_LENGTH = 100;
    uint256 public constant MAX_REPO_LENGTH = 512;

    /// @notice Bounds on maker-chosen oracle settings, as BountyEscrow's createBounty checks.
    uint256 public constant MAX_ALPHA = 1000;
    uint256 public constant MAX_FEE_SCALING_FACTOR = 1000;

    /// @notice Gas forwarded to a recipient when the contract pays out directly (_payOrCredit).
    /// @dev    As in BountyEscrow: capping it makes close-out and settlement cost independent of
    ///         the recipient. A recipient that needs more, or rejects ETH, is credited to
    ///         `withdrawable` and claims with withdraw(), which forwards full gas.
    uint256 public constant PAYOUT_GAS_LIMIT = 120_000;

    /// @notice Erratum E5: a commit carries only hashes; the hunter has this long after it to
    ///         disclose the ciphertext CID, or anyone may expire the claim (bond to the maker,
    ///         prepay back). The window caps how long an undisclosed claim can hold up the
    ///         claims behind it.
    uint256 public constant DISCLOSE_WINDOW = ClaimRules.DISCLOSE_WINDOW;

    /// @notice Erratum E2: the aggregator takes at most 10 CIDs, so a request carries the
    ///         listing, the claim and at most this many prior valid findings (the most recent).
    uint256 public constant MAX_PRIOR_FINDINGS = ClaimRules.MAX_PRIOR_FINDINGS;

    /// @notice The gas every evaluation request is sent with: the wallet clone, and the
    ///         aggregator under it, get exactly this much whatever gas the caller brings. A
    ///         reveal reverts unless it can forward all of it (SUBMISSION_GAS_NEEDED left before
    ///         the call, so a reveal's gas limit is about 10.3M; only the gas used is paid).
    /// @dev    So a refused request is the aggregator's answer, never the caller's choice: with
    ///         the budget forwarded as "all but 1/64" instead, a reveal sent with too little gas
    ///         would run the aggregator (or its keeper, several frames down) out of gas, get
    ///         back the 1/64 reserves of every frame, and enter RoundFailed, a state a hunter
    ///         could then use to walk away from a weak claim. The figure is several times what
    ///         a request costs today (keeper selection over the registered oracles plus K
    ///         dispatches); a request that needs more than this fails the same way for every
    ///         caller, and RoundFailed is then the right answer.
    uint256 public constant SUBMISSION_GAS = ClaimRules.SUBMISSION_GAS;

    /// @notice What a reveal must hold when it sends the request (see SUBMISSION_GAS).
    uint256 public constant SUBMISSION_GAS_NEEDED = ClaimRules.SUBMISSION_GAS_NEEDED;

    // ------------------------------------------------------------------
    //                               state
    // ------------------------------------------------------------------

    IVerdiktaAggregator public immutable verdikta;

    /// @notice The read-only extension (StakeAttestationLens): derived views served at this
    ///         address through the fallback. Created once, in the constructor; no setter.
    StakeAttestationLens public immutable lens;

    /// @notice The EvaluationWallet every request's wallet is an EIP-1167 clone of. Created once,
    ///         in the constructor. Informational: nothing operates the implementation itself.
    EvaluationWallet public immutable walletImplementation;

    /// @notice The fee a maker pays per LISTING_PERIOD, charged by the opening fund() and by
    ///         renew(). Owner-set; a change applies from the next fund or renew.
    uint256 public listingFeeWei;

    /// @notice Where listing fees accrue, as a pull balance in `withdrawable`. Owner-set; a
    ///         change applies from the next fee; what already accrued stays with its recipient.
    address public feeRecipient;

    /// @notice Listing ids run 1..listingCount (0 means "no listing" in every reference).
    uint256 public listingCount;

    mapping(uint256 => Listing) internal _listings;

    /// @dev artifactHash => every listing of it, in listing order.
    mapping(bytes32 => uint256[]) internal _listingsByHash;

    /// @notice artifactHash => maker => the maker's listing of that hash that is not Closed (0 =
    ///         none). Decision D8: at most one per (hash, maker); close() frees the slot.
    mapping(bytes32 => mapping(address => uint256)) public activeListingOf;

    /// @dev listingId => hunter => on the listing's allowlist.
    mapping(uint256 => mapping(address => bool)) internal _allowed;

    /// @notice Pull-payment ledger: listing fees for their recipient, and any payment whose
    ///         direct delivery failed. Claimed with withdraw().
    mapping(address => uint256) public withdrawable;

    /// @notice Claim ids run 1..claimCount across all listings, in commit order.
    uint256 public claimCount;

    mapping(uint256 => Claim) internal _claims;

    /// @dev listingId => the claims judged valid there, in settlement order (pushed by P2c). The
    ///      most recent MAX_PRIOR_FINDINGS ride along in every later request (design §13.3).
    mapping(uint256 => uint256[]) internal _validFindings;

    // Non-reentrancy guard (1 = unlocked, 2 = locked), as BountyEscrow's.
    uint256 private _lock = 1;

    // ------------------------------------------------------------------
    //                               events
    // ------------------------------------------------------------------

    /// @notice A listing was created. The artifact's identity (the preimage of artifactHash) is
    ///         only in this event; the terms are in getListing.
    event Listed(
        uint256 indexed listingId,
        address indexed maker,
        bytes32 indexed artifactHash,
        ArtifactKind kind,
        string repo,
        string baseCommit,
        uint64 chainId,
        address artifactAddress,
        string listingCid,
        string disputeCid
    );

    /// @notice Escrow was added (the opening amount net of the fee, or a top-up).
    event Funded(uint256 indexed listingId, address indexed maker, uint256 amountWei, uint256 escrowWei);

    /// @notice The listing opened: escrow at least the top award and the first period paid. The feed announces it.
    event Opened(uint256 indexed listingId, bytes32 indexed artifactHash, uint256 escrowWei, uint64 fundedUntil);

    /// @notice A Depleted listing is back at the top award with nothing owed, and accepts commits again.
    event Reopened(uint256 indexed listingId, uint256 escrowWei);

    /// @notice A listing period was bought.
    event Renewed(uint256 indexed listingId, uint256 feeWei, uint64 fundedUntil);

    /// @notice A listing fee was credited to the fee recipient's pull balance.
    event ListingFeeAccrued(uint256 indexed listingId, address indexed recipient, uint256 feeWei);

    /// @notice The listing closed and its escrow went back to the maker. The history stays.
    event Closed(uint256 indexed listingId, address indexed maker, uint256 amountReturned);

    event ListingFeeSet(uint256 previousFeeWei, uint256 newFeeWei);
    event FeeRecipientSet(address indexed previousRecipient, address indexed newRecipient);

    /// @notice A direct payment couldn't be delivered and was credited to the pull ledger instead.
    event PaymentDeferred(address indexed to, uint256 amount);

    /// @notice An address claimed its pull-ledger balance.
    event Withdrawn(address indexed account, uint256 amount);

    /// @notice A hunter committed: two hashes, the bond and the prepay; nothing readable (E5).
    event Committed(
        uint256 indexed claimId,
        uint256 indexed listingId,
        address indexed hunter,
        bytes32 archiveHash,
        bytes32 ciphertextSha256,
        uint256 bondWei,
        uint256 prepayWei
    );

    /// @notice The hunter published the encrypted archive's CID; the fix window runs to fixWindowEnd.
    event Disclosed(uint256 indexed claimId, uint256 indexed listingId, string ciphertextCid, uint64 fixWindowEnd);

    /// @notice The maker flagged the disclosure as bad (a statement on the record, not a verdict).
    event Flagged(uint256 indexed claimId, uint256 indexed listingId);

    /// @notice The maker waived the fix window: the claim is revealable now.
    event Released(uint256 indexed claimId, uint256 indexed listingId);

    /// @notice The stake rolled to a fixed version: every disclosed pending claim is revealable.
    event RolledForward(uint256 indexed listingId, uint256 indexed successorListingId, bytes32 indexed successorArtifactHash);

    /// @notice The hunter revealed: the plaintext archive and the two keys are public from here.
    event Revealed(uint256 indexed claimId, uint256 indexed listingId, string bcid, bytes16 contentKey, bytes32 ephemeralKey);

    /// @notice The evaluation request went out through `wallet` with `prepayWei`.
    event EvaluationRequested(uint256 indexed claimId, address wallet, bytes32 requestId, uint256 prepayWei);

    /// @notice The aggregator refused the request; the claim is RoundFailed and the prepay held.
    event SubmissionFailed(uint256 indexed claimId, address wallet, bytes reason);

    /// @notice The claim expired: its bond went to the maker and its prepay back to the hunter.
    event Expired(uint256 indexed claimId, uint256 indexed listingId, Expiry reason);

    // ------------------------------------------------------------------

    constructor(
        IVerdiktaAggregator verdikta_,
        address initialOwner,
        address feeRecipient_,
        uint256 listingFeeWei_
    ) Ownable(initialOwner) {
        require(address(verdikta_) != address(0), "zero aggregator");
        // address(this) would credit every fee to a balance nobody can withdraw.
        require(feeRecipient_ != address(0) && feeRecipient_ != address(this), "bad fee recipient");
        verdikta = verdikta_;
        feeRecipient = feeRecipient_;
        listingFeeWei = listingFeeWei_;
        emit FeeRecipientSet(address(0), feeRecipient_);
        emit ListingFeeSet(0, listingFeeWei_);
        // Both creation codes live in this contract's initcode, not in the runtime bytecode
        // that EIP-170 caps.
        lens = new StakeAttestationLens(verdikta_);
        walletImplementation = new EvaluationWallet(address(this), verdikta_);
    }

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------------
    //                          listing lifecycle
    // ------------------------------------------------------------------

    /// @notice Create a listing from the attested archives. The site has validated them (design
    ///         §8.2); the contract trusts only what it stores, so every term is checked here.
    /// @param p              the artifact, the stake terms and the oracle settings
    /// @param listingCid     the evaluation archive's CID
    /// @param disputeCid     the dispute archive's CID (the same listing with the dispute panel)
    /// @param knownIssueIds  the known issues' ids (sha256 digests), strictly ascending
    function list(
        ListParams calldata p,
        string calldata listingCid,
        string calldata disputeCid,
        bytes32[] calldata knownIssueIds
    ) external returns (uint256 listingId) {
        require(_isValidCid(listingCid), "bad listingCid");
        require(_isValidCid(disputeCid), "bad disputeCid");
        bytes32 artifactHash = _checkedArtifactHash(p.artifact);
        require(p.disclosureKey != bytes32(0), "no disclosure key");
        _checkAwards(p.awards, p.lowestClassCounted);
        _checkWindows(p.fixWindow, p.disputeWindow, p.disclosureGrace, p.revealWindow);
        _checkOracle(p.oracle);
        _checkKnownIssues(knownIssueIds);
        require(p.allowlist.length <= MAX_ALLOWLIST, "allowlist too long");
        require(activeListingOf[artifactHash][msg.sender] == 0, "active listing exists");

        listingId = ++listingCount;
        Listing storage l = _listings[listingId];
        l.maker = msg.sender;
        l.artifactKind = p.artifact.kind;
        l.lowestClassCounted = p.lowestClassCounted;
        l.listedAt = uint64(block.timestamp);
        l.fixWindow = p.fixWindow;
        l.disputeWindow = p.disputeWindow;
        l.disclosureGrace = p.disclosureGrace;
        l.revealWindow = p.revealWindow;
        l.artifactAddress = p.artifact.addr;
        l.artifactChainId = p.artifact.chainId;
        l.artifactHash = artifactHash;
        l.disclosureKey = p.disclosureKey;
        l.listingCid = listingCid;
        l.disputeCid = disputeCid;
        l.awards = p.awards;
        l.bondWei = p.bondWei;
        l.valueAtRiskUsd = p.valueAtRiskUsd;
        l.knownIssueIds = knownIssueIds;
        l.oracle = p.oracle;
        for (uint256 i = 0; i < p.allowlist.length; ) {
            address hunter = p.allowlist[i];
            require(hunter != address(0) && !_allowed[listingId][hunter], "bad allowlist");
            _allowed[listingId][hunter] = true;
            l.allowlist.push(hunter);
            unchecked { ++i; }
        }

        activeListingOf[artifactHash][msg.sender] = listingId;
        _listingsByHash[artifactHash].push(listingId);

        emit Listed(
            listingId,
            msg.sender,
            artifactHash,
            p.artifact.kind,
            p.artifact.repo,
            p.artifact.baseCommit,
            p.artifact.chainId,
            p.artifact.addr,
            listingCid,
            disputeCid
        );
    }

    /// @notice Add escrow. On a Listed listing this is the OPENING fund: msg.value pays the
    ///         listing fee and escrows the rest, which must reach awards[CRITICAL]; the listing
    ///         opens for LISTING_PERIOD. On an Open, Depleted or Rolled listing it is a top-up
    ///         with no fee: a Depleted listing reopens once its escrow is back at
    ///         awards[CRITICAL] and nothing is owed; a Rolled one stays Rolled (no new commits)
    ///         and the escrow pays the claims still settling against it.
    /// @param expectedFeeWei the fee the caller expects this call to charge: feeDue(listingId),
    ///        i.e. the listing fee for an opening fund and 0 for a top-up. A mismatch reverts,
    ///        so a fee change landing first can never take part of the escrow.
    function fund(uint256 listingId, uint256 expectedFeeWei) external payable nonReentrant {
        Listing storage l = _mustListing(listingId);
        require(msg.sender == l.maker, "not maker");
        ListingState s = l.state;
        require(s != ListingState.Closed, "not fundable");
        uint256 fee = s == ListingState.Listed ? listingFeeWei : 0;
        require(expectedFeeWei == fee, "fee changed");

        if (s == ListingState.Listed) {
            require(msg.value >= fee, "fee not paid");
            uint256 amount = msg.value - fee;
            uint256 escrow = l.escrowWei + amount;
            require(escrow >= l.awards[3], "escrow below top award");
            // LISTING_PERIOD is fixed and block.timestamp fits uint64 for billions of years.
            uint64 until = uint64(block.timestamp + LISTING_PERIOD);
            l.escrowWei = escrow;
            l.state = ListingState.Open;
            l.openedAt = uint64(block.timestamp);
            l.fundedUntil = until;
            _accrueFee(listingId, fee);
            emit Funded(listingId, msg.sender, amount, escrow);
            emit Opened(listingId, l.artifactHash, escrow, until);
        } else {
            require(msg.value > 0, "no value");
            uint256 escrow = l.escrowWei + msg.value;
            l.escrowWei = escrow;
            emit Funded(listingId, msg.sender, msg.value, escrow);
            if (s == ListingState.Depleted && escrow >= l.awards[3] && l.owedWei == 0) {
                l.state = ListingState.Open;
                emit Reopened(listingId, escrow);
            }
        }
    }

    /// @notice Buy another LISTING_PERIOD for exactly the current listing fee. Extends
    ///         fundedUntil by LISTING_PERIOD, or, once it has lapsed, runs LISTING_PERIOD from
    ///         now (a lapsed gap is not bought). Escrow is untouched.
    function renew(uint256 listingId) external payable nonReentrant {
        Listing storage l = _mustListing(listingId);
        require(msg.sender == l.maker, "not maker");
        require(l.state == ListingState.Open || l.state == ListingState.Depleted, "not renewable");
        uint256 fee = listingFeeWei;
        require(msg.value == fee, "wrong fee");
        uint256 from = l.fundedUntil > block.timestamp ? l.fundedUntil : block.timestamp;
        // Each renewal is paid for and adds 30 days: uint64 seconds cannot be exhausted.
        uint64 until = uint64(from + LISTING_PERIOD);
        l.fundedUntil = until;
        _accrueFee(listingId, fee);
        emit Renewed(listingId, fee, until);
    }

    /// @notice End the listing and withdraw its escrow to the maker. Refused while any claim is
    ///         pending or anything is owed to a hunter (decision D8). The badge ends; the history
    ///         stays, and the maker may list the same hash again.
    function close(uint256 listingId) external nonReentrant {
        Listing storage l = _mustListing(listingId);
        require(msg.sender == l.maker, "not maker");
        require(l.state != ListingState.Closed, "already closed");
        require(l.pendingClaims == 0, "claims pending");
        require(l.owedWei == 0, "amount owed");

        address maker = l.maker;
        uint256 amount = l.escrowWei;
        l.state = ListingState.Closed;
        l.escrowWei = 0;
        delete activeListingOf[l.artifactHash][maker];

        emit Closed(listingId, maker, amount);
        _payOrCredit(maker, amount);
    }

    /// @notice Claim ETH credited to you on the pull-payment ledger (listing fees, or a payment
    ///         whose direct delivery failed). Pays msg.sender with full gas.
    function withdraw() external nonReentrant {
        uint256 amt = withdrawable[msg.sender];
        require(amt > 0, "nothing to withdraw");
        withdrawable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amt}("");
        require(ok, "withdraw failed");
        emit Withdrawn(msg.sender, amt);
    }

    // ------------------------------------------------------------------
    //                    claim lifecycle up to the request
    // ------------------------------------------------------------------
    // The bodies are in ClaimLogic (a linked library, for the size limit); each wrapper does the
    // part that needs this contract's internals and documents the function.

    /// @notice Commit a claim: the two commitments, the bond and the prepay (erratum E5). Nothing
    ///         readable goes on-chain, so a maker who sees this transaction pending and lands a
    ///         close or rollForward first learns nothing and the commit reverts, PROVIDED the
    ///         ciphertext is not published yet: pin it only once the commit is mined, then
    ///         disclose within DISCLOSE_WINDOW. (A small raw IPFS file's CID follows from its
    ///         sha256, so a ciphertext pinned early could be fetched by its hash alone.)
    /// @param archiveHash      sha256 of the plaintext claim archive (design §8.5)
    /// @param ciphertextSha256 sha256 of that archive encrypted to the listing's disclosure key
    /// @dev msg.value must be at least bondWei plus the aggregator's live maxTotalFee for the
    ///      listing's (clamped) oracle fee, which the lens quotes as commitPrice; everything above
    ///      the bond is the prepay. The claim joins the tail of the listing's commit-order queue.
    function commit(uint256 listingId, bytes32 archiveHash, bytes32 ciphertextSha256)
        external payable nonReentrant returns (uint256 claimId)
    {
        require(acceptsCommits(listingId), "not accepting commits");
        require(isAllowed(listingId, msg.sender), "not allowed");
        claimId = ++claimCount;
        ClaimLogic.commit(
            _claims, _listings[listingId], verdikta, listingId, claimId, archiveHash, ciphertextSha256, msg.value
        );
    }

    /// @notice Publish the encrypted archive's CID, within DISCLOSE_WINDOW of the commit
    ///         (erratum E5). The fix window and the disclosure grace run from now. A claim
    ///         disclosed after its listing rolled forward gets a full fix window of its own: the
    ///         maker had not seen it when they rolled.
    function disclose(uint256 claimId, string calldata ciphertextCid) external {
        Claim storage c = _mustClaim(claimId);
        require(_isValidCid(ciphertextCid), "bad ciphertextCid");
        ClaimLogic.disclose(c, _listings[c.listingId], claimId, ciphertextCid);
    }

    /// @notice The maker says the disclosed copy does not decrypt or does not match the archive
    ///         hash (design §14). Within disclosureGrace of the disclosure, once. A statement on
    ///         the record, not a verdict: the claim proceeds, and the arbiters' disclosure check
    ///         at reveal decides.
    function flagBadDisclosure(uint256 claimId) external {
        Claim storage c = _mustClaim(claimId);
        ClaimLogic.flagBadDisclosure(c, _listings[c.listingId], claimId);
    }

    /// @notice The maker waives the rest of the fix window for a disclosed claim ("I believe
    ///         this is invalid, reveal now"): it is revealable at once, and the record says
    ///         released. Only inside the window, so the record never says released for a window
    ///         that had already ended.
    function release(uint256 claimId) external {
        Claim storage c = _mustClaim(claimId);
        ClaimLogic.release(c, _listings[c.listingId], claimId);
    }

    /// @notice Roll the stake forward to a fixed version (design §7.1): `successorListingId` is
    ///         the maker's own listing of it, already Open (listed and funded on its own). This
    ///         listing becomes Rolled: no new commits; every claim disclosed by now is revealable
    ///         at once (ClaimRules.revealableAt reads rolledAt, so no claim is touched here); an
    ///         undisclosed claim keeps its disclose deadline. The lineage links both ways.
    function rollForward(uint256 listingId, uint256 successorListingId) external {
        Listing storage l = _mustListing(listingId);
        require(msg.sender == l.maker, "not maker");
        require(l.state == ListingState.Open || l.state == ListingState.Depleted, "not rollable");
        Listing storage s = _mustListing(successorListingId);
        // Open and without a predecessor: never this listing, never one already in a lineage
        // as a successor, never a Rolled one, so the lineage has no cycles.
        require(
            successorListingId != listingId && s.maker == msg.sender && s.state == ListingState.Open
                && s.predecessor == 0,
            "bad successor"
        );
        l.state = ListingState.Rolled;
        l.successor = successorListingId;
        l.rolledAt = uint64(block.timestamp);
        s.predecessor = listingId;
        emit RolledForward(listingId, successorListingId, s.artifactHash);
    }

    /// @notice Reveal a claim and submit its evaluation request. The hunter's, once the fix
    ///         window has ended, every earlier claim on the listing is settled or expired, and
    ///         the reveal window (decision D5) is still open.
    /// @param bcid         the plaintext archive, pinned (its sha256 is archiveHash)
    /// @param contentKey   age's 16-byte file key
    /// @param ephemeralKey the 32-byte X25519 ephemeral secret
    /// @dev Payable (erratum E3): msg.value tops the prepay up to the live maxTotalFee (the lens
    ///      quotes it as revealTopUp); the whole prepay goes to the request and what the oracles
    ///      do not spend comes back through the wallet's ethOwed. The contract alone composes
    ///      the request (design §13.3, errata E1, E2): cids = [listingCid, bcid, up to
    ///      MAX_PRIOR_FINDINGS prior valid bcids], addendum = the E1 disclosure line. It goes out
    ///      through a fresh EvaluationWallet clone with exactly SUBMISSION_GAS, inside
    ///      try/catch: if the aggregator refuses it, the reveal stands, the claim is RoundFailed
    ///      and the prepay stays here (P2d). Too little gas reverts the reveal instead.
    function reveal(uint256 claimId, string calldata bcid, bytes16 contentKey, bytes32 ephemeralKey)
        external payable nonReentrant
    {
        Claim storage c = _mustClaim(claimId);
        require(_isValidCid(bcid), "bad bcid");
        uint256 listingId = c.listingId;
        ClaimLogic.reveal(
            _claims, _listings[listingId], _validFindings[listingId], claimId, bcid, contentKey, ephemeralKey,
            msg.value, verdikta, address(walletImplementation)
        );
    }

    /// @notice Expire a claim nobody can advance any more. Anyone may call. Bond to the maker,
    ///         prepay back to the hunter (the request never went out), recorded on the listing.
    ///         - Undisclosed (erratum E5): from DISCLOSE_WINDOW after the commit. Not held back
    ///           by earlier claims, so an undisclosed claim never blocks the queue for longer
    ///           than the disclose window.
    ///         - Unrevealed (design decision 15, decision D5): from revealWindow after the reveal
    ///           clock started, which is max(revealableAt, when every earlier claim resolved).
    ///           Reverts while an earlier claim is unresolved, so a claim never expires while
    ///           commit order forbids its reveal.
    function expire(uint256 claimId) external nonReentrant {
        Claim storage c = _mustClaim(claimId);
        Listing storage l = _listings[c.listingId];
        (uint256 bond, uint256 prepay) = ClaimLogic.expire(_claims, l, claimId);
        _payOrCredit(l.maker, bond);
        _payOrCredit(c.hunter, prepay);
    }

    // ------------------------------------------------------------------
    //                 owner: the listing fee and its recipient only
    // ------------------------------------------------------------------

    /// @notice Set the listing fee charged by the next opening fund() and renew().
    function setListingFee(uint256 newFeeWei) external onlyOwner {
        emit ListingFeeSet(listingFeeWei, newFeeWei);
        listingFeeWei = newFeeWei;
    }

    /// @notice Set where the next listing fees accrue. Balances already accrued stay with
    ///         their recipient.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0) && newRecipient != address(this), "bad fee recipient");
        emit FeeRecipientSet(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    // ------------------------------------------------------------------
    //                               views
    // ------------------------------------------------------------------

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _mustListing(listingId);
    }

    /// @notice A claim as stored. Its state as of now (Revealable included) and its deadlines
    ///         are the lens's claimState and claimTimes.
    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return _mustClaim(claimId);
    }

    /// @notice Every listing of an artifact hash, in listing order. listingsByHashPage pages it.
    function listingsByHash(bytes32 artifactHash) external view returns (uint256[] memory) {
        return _listingsByHash[artifactHash];
    }

    function listingCountByHash(bytes32 artifactHash) external view returns (uint256) {
        return _listingsByHash[artifactHash].length;
    }

    function listingsByHashPage(bytes32 artifactHash, uint256 offset, uint256 limit)
        external view returns (uint256[] memory page)
    {
        uint256[] storage all = _listingsByHash[artifactHash];
        uint256 n = all.length;
        if (offset >= n) return new uint256[](0);
        uint256 end = n - offset < limit ? n : offset + limit;
        page = new uint256[](end - offset);
        for (uint256 i = offset; i < end; ) {
            page[i - offset] = all[i];
            unchecked { ++i; }
        }
    }

    /// @notice Whether a new claim may be committed now: Open (not Listed, Depleted, Rolled or
    ///         Closed), escrow at least the top award, and the listing period not lapsed. A
    ///         lapsed listing stays Open for its pending claims but takes no new ones.
    function acceptsCommits(uint256 listingId) public view returns (bool) {
        Listing storage l = _mustListing(listingId);
        return l.state == ListingState.Open
            && block.timestamp < l.fundedUntil
            && l.escrowWei >= l.awards[3];
    }

    /// @notice Whether the paid listing period has ended (false before the listing opens).
    function isLapsed(uint256 listingId) external view returns (bool) {
        uint64 until = _mustListing(listingId).fundedUntil;
        return until != 0 && block.timestamp >= until;
    }

    /// @notice The fee the next fund() charges: the listing fee while Listed, else 0. Pass it
    ///         as fund's expectedFeeWei.
    function feeDue(uint256 listingId) external view returns (uint256) {
        return _mustListing(listingId).state == ListingState.Listed ? listingFeeWei : 0;
    }

    /// @notice Whether `hunter` may commit to the listing: everyone when the allowlist is empty.
    function isAllowed(uint256 listingId, address hunter) public view returns (bool) {
        Listing storage l = _mustListing(listingId);
        return l.allowlist.length == 0 || _allowed[listingId][hunter];
    }

    /// @notice The record key of an artifact (design §13.1):
    ///         Repo:     keccak256(abi.encode(uint8(kind), repo, baseCommit))
    ///         Contract: keccak256(abi.encode(uint8(kind), repo, baseCommit, uint64 chainId, address))
    ///         Repo ignores chainId and addr (list() requires them to be zero).
    function artifactHashOf(Artifact calldata a) public pure returns (bytes32) {
        if (a.kind == ArtifactKind.Repo) {
            return keccak256(abi.encode(a.kind, a.repo, a.baseCommit));
        }
        return keccak256(abi.encode(a.kind, a.repo, a.baseCommit, a.chainId, a.addr));
    }

    // ------------------------------------------------------------------
    //                             internals
    // ------------------------------------------------------------------

    function _mustListing(uint256 listingId) internal view returns (Listing storage) {
        require(listingId != 0 && listingId <= listingCount, "bad listingId");
        return _listings[listingId];
    }

    function _mustClaim(uint256 claimId) internal view returns (Claim storage) {
        require(claimId != 0 && claimId <= claimCount, "bad claimId");
        return _claims[claimId];
    }

    /// @dev Credit a listing fee to the CURRENT fee recipient's pull balance. Never escrow.
    function _accrueFee(uint256 listingId, uint256 fee) internal {
        if (fee == 0) return;
        address recipient = feeRecipient;
        withdrawable[recipient] += fee;
        emit ListingFeeAccrued(listingId, recipient, fee);
    }

    /// @dev Try to send `amount` to `to` with at most PAYOUT_GAS_LIMIT gas. If the direct send
    ///      fails (a contract that rejects ETH, or one that needs or burns more gas than the
    ///      cap), credit it to the pull ledger instead of reverting, so a hostile or incompatible
    ///      recipient can never block a close-out, payout or refund, nor dictate how much gas the
    ///      caller must bring. Callers update all state first (checks-effects-interactions).
    function _payOrCredit(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount, gas: PAYOUT_GAS_LIMIT}("");
        if (!ok) {
            withdrawable[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }

    /// @dev Validates the artifact's identity and returns its hash.
    function _checkedArtifactHash(Artifact calldata a) private pure returns (bytes32) {
        require(_isValidRepo(a.repo), "bad repo");
        require(_isValidCommit(a.baseCommit), "bad baseCommit");
        if (a.kind == ArtifactKind.Repo) {
            require(a.chainId == 0 && a.addr == address(0), "repo artifact has a deployment");
        } else {
            require(a.chainId != 0 && a.addr != address(0), "contract artifact needs a deployment");
        }
        return artifactHashOf(a);
    }

    /// @dev Awards never decrease with severity, and the counted class (hence, by monotonicity,
    ///      every class above it) pays more than zero.
    function _checkAwards(uint256[4] calldata awards, Outcome lowest) private pure {
        require(awards[0] <= awards[1] && awards[1] <= awards[2] && awards[2] <= awards[3], "awards decrease");
        require(lowest >= Outcome.LOW, "bad lowestClassCounted");
        require(awards[uint8(lowest) - uint8(Outcome.LOW)] > 0, "counted class pays nothing");
    }

    /// @dev Decision D8's bounds, plus MAX_WINDOW on the reveal and dispute windows.
    function _checkWindows(uint32 fixWindow, uint32 disputeWindow, uint32 disclosureGrace, uint32 revealWindow)
        private pure
    {
        require(fixWindow <= MAX_FIX_WINDOW, "fix window too long");
        require(disclosureGrace <= fixWindow, "grace exceeds fix window");
        require(disputeWindow >= MIN_DISPUTE_WINDOW, "dispute window too short");
        require(disputeWindow <= MAX_WINDOW, "dispute window too long");
        require(revealWindow >= MIN_REVEAL_WINDOW, "reveal window too short");
        require(revealWindow <= MAX_WINDOW, "reveal window too long");
    }

    /// @dev BountyEscrow.createBounty's checks, applied to both fees: reject anything the
    ///      aggregator or keeper would reject when a request is sent, so a bad listing fails at
    ///      listing instead of stranding hunters at reveal or the maker at dispute.
    function _checkOracle(OracleParams calldata o) private view {
        uint256 ceiling = verdikta.maxOracleFee();
        require(o.maxOracleFee > 0, "bad oracle fee");
        require(o.maxOracleFee <= ceiling, "oracle fee above ceiling");
        require(o.disputeMaxOracleFee > 0, "bad dispute oracle fee");
        require(o.disputeMaxOracleFee <= ceiling, "dispute oracle fee above ceiling");
        require(o.estimatedBaseCost < o.maxOracleFee, "base cost must be below fee");
        require(o.estimatedBaseCost < o.disputeMaxOracleFee, "base cost must be below dispute fee");
        require(o.maxFeeBasedScaling >= 1 && o.maxFeeBasedScaling <= MAX_FEE_SCALING_FACTOR, "bad fee scaling");
        require(o.alpha <= MAX_ALPHA, "bad alpha");
        require(
            verdikta.maxTotalFee(o.maxOracleFee) > 0 && verdikta.maxTotalFee(o.disputeMaxOracleFee) > 0,
            "bad budget"
        );
    }

    /// @dev Non-zero and strictly ascending: a canonical set with no duplicates, checked in one pass.
    function _checkKnownIssues(bytes32[] calldata ids) private pure {
        require(ids.length <= MAX_KNOWN_ISSUES, "too many known issues");
        bytes32 prev;
        for (uint256 i = 0; i < ids.length; ) {
            require(ids[i] > prev, "bad knownIssueIds");
            prev = ids[i];
            unchecked { ++i; }
        }
    }

    /// @dev Shape check for an IPFS CID string, as BountyEscrow's: CIDv0 (46 base58 chars) or
    ///      base32 CIDv1, i.e. alphanumeric of a plausible length. The aggregator serializes a
    ///      request as "1:<cid0>,<cid1>:<addendum>", so a ',' or ':' inside a stored CID would
    ///      smuggle archives or an addendum into every evaluation of the listing.
    function _isValidCid(string calldata cid) internal pure returns (bool) {
        bytes calldata b = bytes(cid);
        uint256 len = b.length;
        if (len < MIN_CID_LENGTH || len > MAX_CID_LENGTH) return false;
        for (uint256 i = 0; i < len; ) {
            uint8 c = uint8(b[i]);
            unchecked {
                // 0-9: c-0x30 < 10; A-Z / a-z: fold case with |0x20, then (c|0x20)-0x61 < 26.
                bool ok = (c - 0x30 < 10) || ((c | 0x20) - 0x61 < 26);
                if (!ok) return false;
                ++i;
            }
        }
        return true;
    }

    /// @dev "https://" followed by at least one printable, non-space ASCII byte; at most
    ///      MAX_REPO_LENGTH bytes. Keeps the record key's preimage readable and unambiguous.
    function _isValidRepo(string calldata repo) private pure returns (bool) {
        bytes calldata b = bytes(repo);
        uint256 len = b.length;
        if (len <= 8 || len > MAX_REPO_LENGTH) return false;
        if (bytes8(b[0:8]) != bytes8("https://")) return false;
        for (uint256 i = 8; i < len; ) {
            uint8 c = uint8(b[i]);
            if (c < 0x21 || c > 0x7e) return false;
            unchecked { ++i; }
        }
        return true;
    }

    /// @dev A full commit hash in lowercase hex: 40 characters (SHA-1) or 64 (SHA-256). One
    ///      spelling per commit, so one commit has one record key.
    function _isValidCommit(string calldata hexHash) private pure returns (bool) {
        bytes calldata b = bytes(hexHash);
        uint256 len = b.length;
        if (len != 40 && len != 64) return false;
        for (uint256 i = 0; i < len; ) {
            uint8 c = uint8(b[i]);
            unchecked {
                // 0-9: c-0x30 < 10; a-f: c-0x61 < 6 (wrap-around rejects everything else)
                if (!((c - 0x30 < 10) || (c - 0x61 < 6))) return false;
                ++i;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------
    //                    read-only extension (the lens)
    // ------------------------------------------------------------------

    /// @dev As BountyEscrow's: any selector this contract does not implement is answered by the
    ///      lens AT THIS ADDRESS, so callers keep one address and one merged ABI. A STATICCALL
    ///      into lensDelegate(), which delegatecalls the lens; the static frame makes the EVM
    ///      reject any state change inside the lens, so this is never a write path. Return and
    ///      revert data are copied back verbatim. Not a proxy: `lens` is an immutable with no
    ///      setter. Non-payable, and there is no receive(): plain ETH is refused.
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

    /// @notice Plumbing for the fallback, not for external use: reverts "self only" for every
    ///         caller but this contract, and is reached only inside a static frame, so despite
    ///         its non-view signature it cannot change state.
    function lensDelegate(bytes calldata data) external {
        require(msg.sender == address(this), "self only");
        address target = address(lens);
        // memory-safe: scratch at the free memory pointer, and the block terminates.
        assembly ("memory-safe") {
            let p := mload(0x40)
            calldatacopy(p, data.offset, data.length)
            let ok := delegatecall(gas(), target, p, data.length, 0, 0)
            returndatacopy(p, 0, returndatasize())
            if iszero(ok) { revert(p, returndatasize()) }
            return(p, returndatasize())
        }
    }
}
