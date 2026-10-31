// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IVerdiktaAggregator} from "../interfaces/IVerdiktaAggregator.sol";
import {EvaluationWallet} from "../EvaluationWallet.sol";
import {StakeAttestation} from "../StakeAttestation.sol";
import {ClaimRules} from "./ClaimRules.sol";

/// @title ClaimLogic
/// @notice The bodies of StakeAttestation's claim functions, as an external (linked) library,
///         so the contract stays under the EIP-170 size limit (design §13; build node P2b).
/// @dev Every external function here runs by DELEGATECALL from StakeAttestation, on its storage
///      (the storage pointers it passes), with its msg.sender and its balance, and emits its
///      events (declared in StakeAttestation, so its ABI lists them). The compiler refuses a
///      direct CALL to a state-changing library function, so nothing here is reachable except
///      through the contract, which does the parts that need its internals first: claim and
///      listing lookup, the listing's acceptsCommits / isAllowed, CID shape checks, the
///      non-reentrancy guard, and every outgoing payment (_payOrCredit).
///      Time and fee rules come from ClaimRules, which the lens shares.
library ClaimLogic {
    /// @notice Commit: store the two hashes, the bond and the prepay; join the tail of the
    ///         listing's commit-order queue (erratum E5, decision D5).
    function commit(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        IVerdiktaAggregator verdikta,
        uint256 listingId,
        uint256 claimId,
        bytes32 archiveHash,
        bytes32 ciphertextSha256,
        uint256 value
    ) external {
        require(archiveHash != bytes32(0), "bad archiveHash");
        require(ciphertextSha256 != bytes32(0), "bad ciphertextSha256");
        uint256 fee = verdikta.maxTotalFee(ClaimRules.effectiveFee(l.oracle.maxOracleFee, verdikta.maxOracleFee()));
        require(fee > 0, "bad budget");
        uint256 bond = l.bondWei;
        require(value >= bond + fee, "payment below bond + fee");
        uint256 prepay = value - bond;

        uint64 id = uint64(claimId);
        StakeAttestation.Claim storage c = claims[claimId];
        c.hunter = msg.sender;
        c.committedAt = uint64(block.timestamp);
        c.listingId = uint64(listingId);
        c.bondWei = uint128(bond); // both at most msg.value
        c.prepayWei = uint128(prepay);
        c.archiveHash = archiveHash;
        c.ciphertextSha256 = ciphertextSha256;

        uint64 tail = l.tailClaim;
        if (tail == 0) {
            l.headClaim = id;
            l.headSince = uint64(block.timestamp);
        } else {
            claims[tail].nextInOrder = id;
            c.prevInOrder = tail;
        }
        l.tailClaim = id;
        l.pendingClaims += 1;
        l.claimsCommitted += 1;

        emit StakeAttestation.Committed(claimId, listingId, msg.sender, archiveHash, ciphertextSha256, bond, prepay);
    }

    /// @notice Disclose: the ciphertext CID, within DISCLOSE_WINDOW of the commit; the fix window
    ///         and the grace run from now. The caller has checked the CID's shape.
    function disclose(
        StakeAttestation.Claim storage c,
        StakeAttestation.Listing storage l,
        uint256 claimId,
        string calldata ciphertextCid
    ) external {
        require(msg.sender == c.hunter, "not hunter");
        require(c.state == StakeAttestation.ClaimState.Committed, "not committed");
        require(c.disclosedAt == 0, "already disclosed");
        require(block.timestamp < uint256(c.committedAt) + ClaimRules.DISCLOSE_WINDOW, "disclose window over");
        uint64 end = uint64(block.timestamp + l.fixWindow);
        c.ciphertextCid = ciphertextCid;
        c.disclosedAt = uint64(block.timestamp);
        c.fixWindowEnd = end;
        // Disclosed after a roll-forward: the maker had not seen it, so it gets its own window.
        if (l.state == StakeAttestation.ListingState.Rolled) c.disclosedAfterRoll = true;
        emit StakeAttestation.Disclosed(claimId, c.listingId, ciphertextCid, end);
    }

    /// @notice The maker flags a bad disclosure: within disclosureGrace of it, once.
    function flagBadDisclosure(StakeAttestation.Claim storage c, StakeAttestation.Listing storage l, uint256 claimId)
        external
    {
        require(msg.sender == l.maker, "not maker");
        uint256 disclosedAt = c.disclosedAt;
        require(disclosedAt != 0, "not disclosed");
        require(block.timestamp < disclosedAt + l.disclosureGrace, "grace over");
        require(!c.flaggedBadDisclosure, "already flagged");
        c.flaggedBadDisclosure = true;
        emit StakeAttestation.Flagged(claimId, c.listingId);
    }

    /// @notice The maker waives the rest of a disclosed claim's fix window.
    function release(StakeAttestation.Claim storage c, StakeAttestation.Listing storage l, uint256 claimId) external {
        require(msg.sender == l.maker, "not maker");
        require(c.disclosedAt != 0, "not disclosed");
        // Inside the window a disclosed claim is necessarily still Committed.
        require(block.timestamp < revealableAt(c, l), "not in fix window");
        c.released = true;
        c.fixWindowEnd = uint64(block.timestamp);
        emit StakeAttestation.Released(claimId, c.listingId);
    }

    /// @notice Reveal and submit the evaluation request (design §13.3; errata E1-E3). The
    ///         caller has checked the bcid's shape and holds the non-reentrancy lock.
    /// @param prior the listing's valid findings, oldest first (StakeAttestation._validFindings)
    /// @param value msg.value: the top-up
    function reveal(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256[] storage prior,
        uint256 claimId,
        string calldata bcid,
        bytes16 contentKey,
        bytes32 ephemeralKey,
        uint256 value,
        IVerdiktaAggregator verdikta,
        address walletImplementation
    ) external {
        StakeAttestation.Claim storage c = claims[claimId];
        require(msg.sender == c.hunter, "not hunter");
        require(c.state == StakeAttestation.ClaimState.Committed, "not committed");
        require(c.disclosedAt != 0, "not disclosed");
        require(block.timestamp < revealDeadline(c, l, claimId), "reveal window over");

        StakeAttestation.OracleParams memory o = _effectiveOracle(l.oracle, verdikta);
        uint256 live = verdikta.maxTotalFee(o.maxOracleFee);
        require(live > 0, "bad budget");
        uint256 prepay = uint256(c.prepayWei) + value;
        require(prepay >= live, "prepay below fee");

        c.prepayWei = uint128(prepay); // at most what the commit and this call carried
        c.bcid = bcid;
        c.contentKey = contentKey;
        c.ephemeralKey = ephemeralKey;
        c.revealedAt = uint64(block.timestamp);
        address wallet = Clones.clone(walletImplementation);
        c.evalWallet = wallet;
        uint256 listingId = c.listingId;
        emit StakeAttestation.Revealed(claimId, listingId, bcid, contentKey, ephemeralKey);

        // The arguments are built before the call, outside the try: a failure composing them
        // reverts the reveal; only the aggregator's refusal is caught.
        string[] memory cids = _requestCids(claims, l, prior, bcid);
        string memory addendum = _disclosureLine(c, contentKey, ephemeralKey);
        // The request gets exactly SUBMISSION_GAS, so whether it fails cannot depend on the
        // caller's gas limit (see StakeAttestation.SUBMISSION_GAS).
        require(gasleft() >= ClaimRules.SUBMISSION_GAS_NEEDED, "gas below SUBMISSION_GAS_NEEDED");
        try EvaluationWallet(payable(wallet)).startEvaluation{value: prepay, gas: ClaimRules.SUBMISSION_GAS}(
            cids,
            addendum,
            o.alpha,
            o.maxOracleFee,
            o.estimatedBaseCost,
            o.maxFeeBasedScaling,
            o.requestedClass
        ) returns (bytes32 requestId) {
            c.requestId = requestId;
            c.state = StakeAttestation.ClaimState.Revealed;
            emit StakeAttestation.EvaluationRequested(claimId, wallet, requestId, prepay);
        } catch (bytes memory reason) {
            c.state = StakeAttestation.ClaimState.RoundFailed;
            emit StakeAttestation.SubmissionFailed(claimId, wallet, reason);
        }
    }

    /// @notice Expire a claim nobody can advance (see StakeAttestation.expire). Returns what the
    ///         caller pays out: the bond to the maker, the prepay to the hunter.
    function expire(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256 claimId
    ) external returns (uint256 bondWei, uint256 prepayWei) {
        StakeAttestation.Claim storage c = claims[claimId];
        require(c.state == StakeAttestation.ClaimState.Committed, "not committed");
        StakeAttestation.Expiry why;
        if (c.disclosedAt == 0) {
            // Erratum E5: not held back by earlier claims.
            require(block.timestamp >= uint256(c.committedAt) + ClaimRules.DISCLOSE_WINDOW, "disclose window open");
            why = StakeAttestation.Expiry.Undisclosed;
            l.undisclosedClaims += 1;
        } else {
            // Decision D5: reverts while an earlier claim is unresolved.
            require(block.timestamp >= revealDeadline(c, l, claimId), "reveal window open");
            why = StakeAttestation.Expiry.Unrevealed;
            l.unrevealedClaims += 1;
        }
        c.state = StakeAttestation.ClaimState.Expired;
        c.expiry = why;
        resolve(claims, c, l);
        emit StakeAttestation.Expired(claimId, c.listingId, why);
        return (c.bondWei, c.prepayWei);
    }

    // ------------------------------------------------------------------
    //          internal: inlined into each caller (this library, P2c's settle, tests)
    // ------------------------------------------------------------------

    /// @dev A claim leaves the commit-order queue, settled (P2c) or expired. O(1): unlink it.
    ///      When it was the head, the next claim becomes the head and its reveal clock may start
    ///      now (decision D5). Callers set the claim's final state; this keeps pendingClaims and
    ///      the queue true. Must be called exactly once per claim, while it is unresolved.
    function resolve(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Claim storage c,
        StakeAttestation.Listing storage l
    ) internal {
        uint64 prev = c.prevInOrder;
        uint64 next = c.nextInOrder;
        if (prev == 0) {
            l.headClaim = next;
            l.headSince = uint64(block.timestamp);
        } else {
            claims[prev].nextInOrder = next;
        }
        if (next == 0) {
            l.tailClaim = prev;
        } else {
            claims[next].prevInOrder = prev;
        }
        c.prevInOrder = 0;
        c.nextInOrder = 0;
        l.pendingClaims -= 1;
    }

    function revealableAt(StakeAttestation.Claim storage c, StakeAttestation.Listing storage l)
        internal view returns (uint256)
    {
        return ClaimRules.revealableAt(c.disclosedAt, c.fixWindowEnd, c.disclosedAfterRoll, l.rolledAt);
    }

    /// @dev The end of a disclosed claim's reveal window (decision D5), after the two checks
    ///      reveal and expire both need: the fix window is over, and the claim heads the
    ///      commit-order queue (every earlier claim settled or expired). O(1): no scan.
    function revealDeadline(StakeAttestation.Claim storage c, StakeAttestation.Listing storage l, uint256 claimId)
        internal view returns (uint256)
    {
        uint256 revealable = revealableAt(c, l);
        require(block.timestamp >= revealable, "fix window open");
        require(l.headClaim == claimId, "earlier claim unresolved");
        return ClaimRules.revealDeadline(revealable, l.headSince, l.revealWindow);
    }

    // ------------------------------------------------------------------
    //                    private: request composition
    // ------------------------------------------------------------------

    /// @dev The oracle settings a request is sent with now, as BountyEscrow._effectiveOracle:
    ///      the fee clamped to the aggregator's live ceiling, and the base cost kept below it
    ///      (the keeper requires base < fee; without this a lowered ceiling would make every
    ///      reveal revert). alpha, scaling and class unchanged.
    function _effectiveOracle(StakeAttestation.OracleParams storage s, IVerdiktaAggregator verdikta)
        private view returns (StakeAttestation.OracleParams memory o)
    {
        o = s;
        uint256 fee = ClaimRules.effectiveFee(o.maxOracleFee, verdikta.maxOracleFee());
        o.maxOracleFee = fee;
        if (o.estimatedBaseCost >= fee) o.estimatedBaseCost = fee > 0 ? fee - 1 : 0;
    }

    /// @dev Design §13.3 with erratum E2: [listingCid, the claim's bcid, the bcids of the most
    ///      recent MAX_PRIOR_FINDINGS valid claims on this listing, oldest first]. At most 10,
    ///      the aggregator's MAX_CID_COUNT. Every entry passed the CID shape check when stored.
    function _requestCids(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256[] storage prior,
        string calldata bcid
    ) private view returns (string[] memory cids) {
        uint256 n = prior.length;
        uint256 m = n < ClaimRules.MAX_PRIOR_FINDINGS ? n : ClaimRules.MAX_PRIOR_FINDINGS;
        cids = new string[](2 + m);
        cids[0] = l.listingCid;
        cids[1] = bcid;
        for (uint256 k = 0; k < m; ) {
            cids[2 + k] = claims[prior[n - m + k]].bcid;
            unchecked { ++k; }
        }
    }

    /// @dev Erratum E1, the addendum's one line, single spaces, lowercase hex:
    ///      verdikta-disclosure: 0x<archiveSha256> 0x<ciphertextSha256> <ciphertextCid>
    ///                           0x<contentKey, 32 hex> 0x<ephemeralKey, 64 hex>
    ///      303 to 357 bytes (the CID is 46 to 100), inside the aggregator's 1,000. The EA reads
    ///      and strips it before any model sees the prompt; nothing else goes in the addendum.
    function _disclosureLine(StakeAttestation.Claim storage c, bytes16 contentKey, bytes32 ephemeralKey)
        private view returns (string memory)
    {
        return string.concat(
            "verdikta-disclosure: ",
            Strings.toHexString(uint256(c.archiveHash), 32), " ",
            Strings.toHexString(uint256(c.ciphertextSha256), 32), " ",
            c.ciphertextCid, " ",
            Strings.toHexString(uint128(contentKey), 16), " ",
            Strings.toHexString(uint256(ephemeralKey), 32)
        );
    }
}
