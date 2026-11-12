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
///         so the contract stays under the EIP-170 size limit (design §13; build nodes P2b-P2e).
/// @dev Every external function here runs by DELEGATECALL from StakeAttestation, on its storage
///      (the storage pointers it passes), with its msg.sender and its balance, and emits its
///      events (declared in StakeAttestation, so its ABI lists them). The compiler refuses a
///      direct CALL to a state-changing library function, so nothing here is reachable except
///      through the contract, which does the parts that need its internals first: claim and
///      listing lookup, the listing's acceptsCommits / isAllowed, CID shape checks, the
///      non-reentrancy guard, and every outgoing payment (_payOrCredit).
///      Time and fee rules come from ClaimRules, which the lens shares.
///
///      Late claims (P2e, decision D6) run through the same functions: `late` is set at commit and
///      every later step is a claim's, except that settle pays no award, a late claim is not one
///      of the listing's pendingClaims (resolve), and its counts go to the listing's `later`
///      (lateClaims, lateOutcomeCounts, lateExpired) instead of the history: never claimsCommitted,
///      outcomeCounts, releasedClaims, the expiry counts or the dispute counts.
library ClaimLogic {
    /// @notice Commit: store the two hashes, the bond and the prepay; join the tail of the
    ///         listing's commit-order queue (erratum E5, decision D5). The caller has checked
    ///         acceptsCommits and isAllowed for a commit; `late` (lateClaim, decision D6) needs
    ///         instead a listing whose stake ended: Rolled, or Closed after it opened (closed
    ///         unfunded, it never had one). No allowlist.
    function commit(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        IVerdiktaAggregator verdikta,
        uint256 listingId,
        uint256 claimId,
        bytes32 archiveHash,
        bytes32 ciphertextSha256,
        uint256 value,
        bool late
    ) external {
        if (late) {
            StakeAttestation.ListingState s = l.state;
            require(
                s == StakeAttestation.ListingState.Rolled
                    || (s == StakeAttestation.ListingState.Closed && l.openedAt != 0),
                "not accepting late claims"
            );
        }
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
        if (late) {
            // Behind every pending claim in the queue, but never one of pendingClaims: no award
            // rides on it, so it holds neither close() nor the escrow.
            c.late = true;
            l.lateClaims += 1;
            emit StakeAttestation.LateClaim(claimId, listingId, msg.sender, archiveHash, ciphertextSha256, bond, prepay);
        } else {
            l.pendingClaims += 1;
            l.claimsCommitted += 1;
            emit StakeAttestation.Committed(claimId, listingId, msg.sender, archiveHash, ciphertextSha256, bond, prepay);
        }
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
        // rolledAt, not the state: a late claim on a listing that rolled and then closed is
        // disclosed after the roll too.
        if (l.rolledAt != 0) c.disclosedAfterRoll = true;
        emit StakeAttestation.Disclosed(claimId, c.listingId, ciphertextCid, end);
    }

    /// @notice The maker flags a bad disclosure: within disclosureGrace of it, once. The claim
    ///         joins the listing's flagged claims, in flag order, for the record.
    /// @param flagged the listing's flagged claims (StakeAttestation._flaggedClaims)
    function flagBadDisclosure(
        StakeAttestation.Claim storage c,
        StakeAttestation.Listing storage l,
        uint256[] storage flagged,
        uint256 claimId
    ) external {
        require(msg.sender == l.maker, "not maker");
        uint256 disclosedAt = c.disclosedAt;
        require(disclosedAt != 0, "not disclosed");
        require(block.timestamp < disclosedAt + l.disclosureGrace, "grace over");
        require(!c.flaggedBadDisclosure, "already flagged");
        c.flaggedBadDisclosure = true;
        flagged.push(claimId);
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
        if (!c.late) l.releasedClaims += 1;
        emit StakeAttestation.Released(claimId, c.listingId);
    }

    /// @notice Reveal and submit the evaluation request (design §13.3; errata E1-E3). The
    ///         caller has checked the bcid's shape and holds the non-reentrancy lock.
    /// @param prior   the listing's valid findings, oldest first (StakeAttestation._validFindings)
    /// @param wallets StakeAttestation.walletInfo: the new wallet's funder is recorded there
    /// @param value   msg.value: the top-up
    function reveal(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256[] storage prior,
        mapping(address => StakeAttestation.WalletInfo) storage wallets,
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
        c.bcid = bcid;
        c.contentKey = contentKey;
        c.ephemeralKey = ephemeralKey;
        c.revealedAt = uint64(block.timestamp);
        emit StakeAttestation.Revealed(claimId, c.listingId, bcid, contentKey, ephemeralKey);
        // The commit's prepay plus the top-up: at most what the commit and this call carried.
        _submit(claims, l, prior, wallets, claimId, uint256(c.prepayWei) + value, verdikta, walletImplementation);
    }

    /// @notice Re-trigger a failed round (see StakeAttestation.retrigger; erratum E6). The
    ///         caller holds the non-reentrancy lock.
    /// @param value msg.value: the fresh prepay, or the top-up of a refused submission's held one
    function retrigger(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256[] storage prior,
        mapping(address => StakeAttestation.WalletInfo) storage wallets,
        uint256 claimId,
        uint256 value,
        IVerdiktaAggregator verdikta,
        address walletImplementation
    ) external {
        StakeAttestation.Claim storage c = claims[claimId];
        require(msg.sender == c.hunter, "not hunter");
        require(c.state == StakeAttestation.ClaimState.RoundFailed, "not failed");
        require(block.timestamp < ClaimRules.retriggerDeadline(c.failedAt, l.revealWindow), "retrigger window over");
        // A refused submission (requestId 0) left its prepay here; a round that ran spent it.
        uint256 held = c.requestId == bytes32(0) ? c.prepayWei : 0;
        emit StakeAttestation.Retriggered(claimId, c.listingId);
        _submit(claims, l, prior, wallets, claimId, held + value, verdikta, walletImplementation);
    }

    /// @notice Expire a claim nobody can advance (see StakeAttestation.expire). Returns what the
    ///         caller pays out: the bond to `bondTo`, the prepay still held to the hunter.
    function expire(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256 claimId
    ) external returns (address bondTo, uint256 bondWei, uint256 prepayWei) {
        StakeAttestation.Claim storage c = claims[claimId];
        StakeAttestation.Expiry why;
        bondTo = l.maker;
        prepayWei = c.prepayWei;
        if (c.state == StakeAttestation.ClaimState.RoundFailed) {
            // Erratum E6: once the hunter can no longer re-trigger, the bond follows the rounds.
            require(
                block.timestamp >= ClaimRules.retriggerDeadline(c.failedAt, l.revealWindow), "retrigger window open"
            );
            if (c.roundStarted) {
                why = StakeAttestation.Expiry.RoundsFailed;
            } else {
                why = StakeAttestation.Expiry.SubmissionsRefused;
                bondTo = c.hunter;
            }
            // The last attempt's prepay is held only if it was refused; a round that ran spent it.
            if (c.requestId != bytes32(0)) prepayWei = 0;
        } else {
            require(c.state == StakeAttestation.ClaimState.Committed, "not committed");
            if (c.disclosedAt == 0) {
                // Erratum E5: not held back by earlier claims.
                require(
                    block.timestamp >= uint256(c.committedAt) + ClaimRules.DISCLOSE_WINDOW, "disclose window open"
                );
                why = StakeAttestation.Expiry.Undisclosed;
            } else {
                // Decision D5: reverts while an earlier claim is unresolved.
                require(block.timestamp >= revealDeadline(c, l, claimId), "reveal window open");
                why = StakeAttestation.Expiry.Unrevealed;
            }
        }
        if (c.late) l.lateExpired += 1;
        else if (why == StakeAttestation.Expiry.Undisclosed) l.undisclosedClaims += 1;
        else if (why == StakeAttestation.Expiry.Unrevealed) l.unrevealedClaims += 1;
        else l.noVerdictClaims += 1;
        c.state = StakeAttestation.ClaimState.Expired;
        c.expiry = why;
        resolve(claims, c, l);
        emit StakeAttestation.Expired(claimId, c.listingId, why);
        bondWei = c.bondWei;
    }

    // ------------------------------------------------------------------
    //                         dispute (P2d)
    // ------------------------------------------------------------------

    /// @notice The maker disputes a valid verdict (see StakeAttestation.dispute; design §13.2,
    ///         erratum E2). The caller has checked the statement CID's shape and holds the
    ///         non-reentrancy lock.
    /// @param value msg.value: the dispute's prepay, all of it sent with the request
    function dispute(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256[] storage prior,
        mapping(address => StakeAttestation.WalletInfo) storage wallets,
        uint256 claimId,
        string calldata statementCid,
        uint256 value,
        IVerdiktaAggregator verdikta,
        address walletImplementation
    ) external {
        StakeAttestation.Claim storage c = claims[claimId];
        address maker = l.maker;
        require(msg.sender == maker, "not maker");
        require(c.state == StakeAttestation.ClaimState.Judged, "not judged");
        require(c.dispute == StakeAttestation.DisputeResult.None, "already disputed");
        require(uint8(c.outcome) >= ClaimRules.LOW, "not a valid outcome");
        require(block.timestamp < uint256(c.judgedAt) + l.disputeWindow, "dispute window over");
        StakeAttestation.OracleParams memory o = _effectiveOracle(l.oracle, l.oracle.disputeMaxOracleFee, verdikta);
        uint256 live = verdikta.maxTotalFee(o.maxOracleFee);
        require(live > 0, "bad budget");
        require(value >= live, "prepay below fee");

        address wallet = _newWallet(wallets, walletImplementation, maker, claimId);
        c.state = StakeAttestation.ClaimState.Disputed;
        c.dispute = StakeAttestation.DisputeResult.Pending;
        c.disputedOutcome = c.outcome;
        c.disputedAt = uint64(block.timestamp);
        c.disputeWallet = wallet;
        if (!c.late) l.disputesFiled += 1;

        // Erratum E2: the dispute archive first, then what the claim's own round carried (no
        // claim on the listing can have settled since: this one has headed the queue from its
        // reveal); the statement by CID in the addendum's second line, never as text.
        string[] memory cids = _requestCids(claims, l.disputeCid, prior, c.bcid);
        string memory addendum = string.concat(_disclosureLine(c), "\nverdikta-dispute: ", statementCid);
        // Exactly SUBMISSION_GAS, as a claim round's request, so what the aggregator does with
        // the request cannot depend on the maker's gas limit. Not caught: a refusal (or a
        // request that needs more) reverts the dispute, so nothing is recorded and the maker
        // may try again inside the window.
        require(gasleft() >= ClaimRules.SUBMISSION_GAS_NEEDED, "gas below SUBMISSION_GAS_NEEDED");
        bytes32 requestId = EvaluationWallet(payable(wallet)).startEvaluation{value: value, gas: ClaimRules.SUBMISSION_GAS}(
            cids,
            addendum,
            o.alpha,
            o.maxOracleFee,
            o.estimatedBaseCost,
            o.maxFeeBasedScaling,
            o.requestedClass
        );
        c.disputeRequestId = requestId;
        emit StakeAttestation.Disputed(claimId, c.listingId, statementCid, wallet, requestId, value);
    }

    /// @notice Recover a wallet's unspent prepay for its funder (see
    ///         StakeAttestation.recoverLeftoverEth). The caller holds the non-reentrancy lock and
    ///         pays `refunded` to `funder`.
    function recoverLeftover(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        mapping(address => StakeAttestation.WalletInfo) storage wallets,
        address wallet
    ) external returns (address funder, uint256 refunded) {
        StakeAttestation.WalletInfo memory w = wallets[wallet];
        funder = w.funder;
        require(funder != address(0), "unknown wallet");
        StakeAttestation.Claim storage c = claims[w.claimId];
        StakeAttestation.ClaimState s = c.state;
        // A claim's rounds run one at a time, so its open round, if any, is its current
        // wallet's (a claim round) or its dispute wallet's.
        require(
            !(s == StakeAttestation.ClaimState.Revealed && wallet == c.evalWallet)
                && !(s == StakeAttestation.ClaimState.Disputed && wallet == c.disputeWallet),
            "round open"
        );
        refunded = EvaluationWallet(payable(wallet)).refundLeftoverEth();
        require(refunded > 0, "nothing to recover");
        emit StakeAttestation.LeftoverRefunded(w.claimId, funder, refunded);
    }

    // ------------------------------------------------------------------
    //                 judgement and settlement (P2c)
    // ------------------------------------------------------------------

    /// @notice Finalize by polling (erratum E4; modelled on BountyEscrow.finalizeSubmission).
    ///         Reads the claim's open round: its claim round while Revealed, its dispute round
    ///         while Disputed. With no result, tries finalizeEvaluationTimeout and asks
    ///         getAggregationStatus whether the round is over: still open reverts (try later),
    ///         over without a result is a failed round. A result that is no verdict
    ///         (ClaimRules.judge) is a failed round too, never a revert, so a claim is never
    ///         stuck in Revealed or Disputed.
    ///         - A claim round's verdict is stored with its outcome and judgedAt, which starts the
    ///           dispute window; a failed claim round makes the claim RoundFailed (erratum E6),
    ///           and its first failure starts the re-trigger window.
    ///         - A dispute round's verdict is final and replaces the first (Held when the outcome
    ///           is the same, the record's failed dispute; else Overturned); a failed dispute
    ///           round leaves the first verdict standing (NoVerdict). Either way the claim is
    ///           Judged again and settle may follow at once.
    ///         Either way the round is over, so its wallet's unspent prepay is recovered (best
    ///         effort, gas-capped) for the caller to pay to the wallet's funder.
    /// @return payee    the round's funder: the hunter for a claim round, the maker for a dispute
    /// @return refunded the wallet's recovered balance (0 if there was none or recovery failed)
    function finalize(
        StakeAttestation.Claim storage c,
        StakeAttestation.Listing storage l,
        uint256 claimId,
        IVerdiktaAggregator verdikta
    ) external returns (address payee, uint256 refunded) {
        bool disputed = c.state == StakeAttestation.ClaimState.Disputed;
        require(disputed || c.state == StakeAttestation.ClaimState.Revealed, "not revealed");
        bytes32 requestId = disputed ? c.disputeRequestId : c.requestId;
        (uint256[] memory v, string memory justification, bool ok) = _poll(verdikta, requestId);
        uint256 listingId = c.listingId;
        bool verdict;
        uint8 outcome;
        if (ok) (verdict, outcome) = ClaimRules.judge(v);
        uint32[6] memory packed;
        if (verdict) {
            for (uint256 i = 0; i < 6; ) {
                packed[i] = uint32(v[i]); // judge bounded each by SCORE_SCALE
                unchecked { ++i; }
            }
            c.vector = packed;
            c.outcome = StakeAttestation.Outcome(outcome);
        }
        address wallet;
        if (!disputed) {
            wallet = c.evalWallet;
            payee = c.hunter;
            if (verdict) {
                c.judgedAt = uint64(block.timestamp);
                c.state = StakeAttestation.ClaimState.Judged;
                emit StakeAttestation.Judged(claimId, listingId, StakeAttestation.Outcome(outcome), packed, justification);
            } else {
                // Erratum E6: the round ran and settled no verdict. The claim keeps its place
                // and its bond, and the hunter may re-trigger it (retrigger).
                c.state = StakeAttestation.ClaimState.RoundFailed;
                if (c.failedAt == 0) c.failedAt = uint64(block.timestamp);
                emit StakeAttestation.EvaluationFailed(claimId, listingId, requestId, ok);
            }
        } else {
            wallet = c.disputeWallet;
            payee = l.maker;
            c.state = StakeAttestation.ClaimState.Judged;
            c.disputeEndedAt = uint64(block.timestamp);
            if (verdict) {
                StakeAttestation.DisputeResult result = outcome == uint8(c.disputedOutcome)
                    ? StakeAttestation.DisputeResult.Held
                    : StakeAttestation.DisputeResult.Overturned;
                c.dispute = result;
                // A late claim's dispute is on its finding, never in the history's counts.
                if (!c.late) {
                    if (result == StakeAttestation.DisputeResult.Held) l.disputesHeld += 1;
                    else l.disputesOverturned += 1;
                }
                emit StakeAttestation.DisputeJudged(
                    claimId, listingId, result, StakeAttestation.Outcome(outcome), packed, justification
                );
            } else {
                c.dispute = StakeAttestation.DisputeResult.NoVerdict;
                if (!c.late) l.disputesNoVerdict += 1;
                emit StakeAttestation.DisputeFailed(claimId, listingId, requestId, ok);
            }
        }
        // As BountyEscrow._refundLeftoverEth: the verdict must never depend on the recovery
        // (an aggregator change could make withdrawEth revert), so it is wrapped and gas-capped;
        // and it always gets its whole budget, so a caller cannot starve it into a deferral.
        require(gasleft() >= ClaimRules.INLINE_REFUND_GAS_NEEDED, "gas below INLINE_REFUND_GAS_NEEDED");
        try EvaluationWallet(payable(wallet)).refundLeftoverEth{gas: ClaimRules.INLINE_REFUND_GAS_LIMIT}()
            returns (uint256 amount)
        {
            refunded = amount;
            emit StakeAttestation.LeftoverRefunded(claimId, payee, amount);
        } catch {
            emit StakeAttestation.RefundDeferred(claimId, wallet);
        }
    }

    /// @notice Settle a judged claim (design §8.7, §13.2; decision D5). INVALID and DUPLICATE at
    ///         once, a valid outcome once the dispute window from judgedAt has ended, or at once
    ///         after a dispute (its second finalize was final, and there is one dispute). The claim
    ///         leaves the commit-order queue (resolve), is counted by outcome, and a valid one
    ///         joins the listing's valid findings (published: later requests carry it).
    ///         Funds, returned for the caller to pay (one payee):
    ///         - INVALID: the bond to the maker;
    ///         - DUPLICATE, or valid below lowestClassCounted: the bond back to the hunter;
    ///         - valid and counted: the bond plus min(awards[class], escrowWei) to the hunter; the
    ///           rest of the award is owed (the claim's owedWei, the listing's owedWei, and the
    ///           owed queue, paid by the maker's next fund in commit order). A payout that leaves
    ///           an Open listing's escrow below the top award makes it Depleted.
    ///         - a late claim (decision D6): no award at any class, so the bond alone, and it is
    ///           counted under later (lateOutcomeCounts); a valid one is still published.
    /// @param valid  the listing's valid findings (StakeAttestation._validFindings)
    /// @param owedQ  the listing's owed claims, in settlement order (StakeAttestation._owedClaims)
    function settle(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256[] storage valid,
        uint256[] storage owedQ,
        uint256 claimId
    ) external returns (address payee, uint256 amount) {
        StakeAttestation.Claim storage c = claims[claimId];
        require(c.state == StakeAttestation.ClaimState.Judged, "not judged");
        uint8 outcome = uint8(c.outcome);
        if (outcome >= ClaimRules.LOW && c.dispute == StakeAttestation.DisputeResult.None) {
            require(block.timestamp >= uint256(c.judgedAt) + l.disputeWindow, "dispute window open");
        }
        c.state = StakeAttestation.ClaimState.Settled;
        c.settledAt = uint64(block.timestamp);
        resolve(claims, c, l);
        bool late = c.late;
        if (late) l.lateOutcomeCounts[outcome] += 1;
        else l.outcomeCounts[outcome] += 1;

        address hunter = c.hunter;
        payee = outcome == ClaimRules.INVALID ? l.maker : hunter;
        amount = c.bondWei;
        uint256 paid;
        uint256 owed;
        if (outcome >= ClaimRules.LOW) {
            // Published, late or not: later requests carry it as a prior finding (§13.3).
            valid.push(claimId);
            uint256 award = late ? 0 : ClaimRules.awardFor(l.awards, uint8(l.lowestClassCounted), outcome);
            if (award != 0) {
                uint256 escrow = l.escrowWei;
                paid = award < escrow ? award : escrow;
                owed = award - paid;
                escrow -= paid;
                l.escrowWei = escrow;
                // Both at most awards[CRITICAL], which an opening fund had to escrow.
                c.paidWei = uint128(paid);
                if (owed != 0) {
                    c.owedWei = uint128(owed);
                    l.owedWei += owed;
                    owedQ.push(claimId);
                }
                amount += paid;
                if (l.state == StakeAttestation.ListingState.Open && escrow < l.awards[3]) {
                    l.state = StakeAttestation.ListingState.Depleted;
                    emit StakeAttestation.Depleted(c.listingId, escrow);
                }
            }
        }
        emit StakeAttestation.Settled(claimId, c.listingId, hunter, StakeAttestation.Outcome(outcome), paid, owed);
    }

    /// @notice A top-up first pays what the listing owes, claim by claim in commit order (claims
    ///         reveal, hence settle, in commit order, so the owed queue is in commit order), the
    ///         last one partly if `amount` runs out. Each payment is credited to the hunter's
    ///         pull balance (withdraw), so the loop makes no external call.
    /// @return rest what is left of `amount` for the escrow
    function payOwed(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256[] storage owedQ,
        mapping(address => uint256) storage withdrawable,
        uint256 listingId,
        uint256 amount
    ) external returns (uint256 rest) {
        uint256 i = l.owedCursor;
        uint256 n = owedQ.length;
        uint256 total = l.owedWei;
        while (amount != 0 && i < n) {
            uint256 claimId = owedQ[i];
            StakeAttestation.Claim storage c = claims[claimId];
            uint256 owed = c.owedWei;
            uint256 pay = owed < amount ? owed : amount;
            owed -= pay;
            amount -= pay;
            total -= pay;
            c.owedWei = uint128(owed);
            c.paidWei += uint128(pay); // paid + owed is the award: at most awards[CRITICAL]
            address hunter = c.hunter;
            withdrawable[hunter] += pay;
            emit StakeAttestation.OwedPaid(claimId, listingId, hunter, pay, owed);
            if (owed != 0) break;
            unchecked { ++i; }
        }
        l.owedCursor = uint64(i);
        l.owedWei = total;
        return amount;
    }

    // ------------------------------------------------------------------
    //          internal: inlined into each caller (this library, tests)
    // ------------------------------------------------------------------

    /// @dev A claim leaves the commit-order queue, settled or expired. O(1): unlink it.
    ///      When it was the head, the next claim becomes the head and its reveal clock may start
    ///      now (decision D5). Callers set the claim's final state; this keeps pendingClaims (which
    ///      a late claim is never one of) and the queue true. Must be called exactly once per
    ///      claim, while it is unresolved.
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
        if (!c.late) l.pendingClaims -= 1;
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
    //                    private: requests and their composition
    // ------------------------------------------------------------------

    /// @dev Send a claim round's request (reveal, retrigger): `prepay` must reach the live
    ///      maxTotalFee; a fresh EvaluationWallet clone, funded by the hunter, sends it with
    ///      exactly SUBMISSION_GAS inside try/catch. Accepted: Revealed, and a round has run.
    ///      Refused: RoundFailed with requestId 0, the prepay held here, and the first failure
    ///      starts the re-trigger window.
    function _submit(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        StakeAttestation.Listing storage l,
        uint256[] storage prior,
        mapping(address => StakeAttestation.WalletInfo) storage wallets,
        uint256 claimId,
        uint256 prepay,
        IVerdiktaAggregator verdikta,
        address walletImplementation
    ) private {
        StakeAttestation.Claim storage c = claims[claimId];
        StakeAttestation.OracleParams memory o = _effectiveOracle(l.oracle, l.oracle.maxOracleFee, verdikta);
        uint256 live = verdikta.maxTotalFee(o.maxOracleFee);
        require(live > 0, "bad budget");
        require(prepay >= live, "prepay below fee");
        c.prepayWei = uint128(prepay); // at most what this claim's transactions carried
        address wallet = _newWallet(wallets, walletImplementation, c.hunter, claimId);
        c.evalWallet = wallet;

        // The arguments are built before the call, outside the try: a failure composing them
        // reverts the call; only the aggregator's refusal is caught.
        string[] memory cids = _requestCids(claims, l.listingCid, prior, c.bcid);
        string memory addendum = _disclosureLine(c);
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
            c.roundStarted = true;
            c.state = StakeAttestation.ClaimState.Revealed;
            emit StakeAttestation.EvaluationRequested(claimId, wallet, requestId, prepay);
        } catch (bytes memory reason) {
            c.requestId = bytes32(0);
            c.state = StakeAttestation.ClaimState.RoundFailed;
            if (c.failedAt == 0) c.failedAt = uint64(block.timestamp);
            emit StakeAttestation.SubmissionFailed(claimId, wallet, reason);
        }
    }

    /// @dev A fresh EvaluationWallet clone for one request, its funder on record (walletInfo).
    function _newWallet(
        mapping(address => StakeAttestation.WalletInfo) storage wallets,
        address walletImplementation,
        address funder,
        uint256 claimId
    ) private returns (address wallet) {
        wallet = Clones.clone(walletImplementation);
        wallets[wallet] = StakeAttestation.WalletInfo(funder, uint64(claimId));
    }

    /// @dev Read a round (erratum E4): its result, or, with none yet, settle a timed-out round at
    ///      the aggregator and read again; reverts "evaluation not ready" while it is still open.
    ///      `ok` false on return: the round is over without a result.
    function _poll(IVerdiktaAggregator verdikta, bytes32 requestId)
        private returns (uint256[] memory v, string memory justification, bool ok)
    {
        (v, justification, ok) = verdikta.getEvaluation(requestId);
        if (!ok) {
            // Timed out but not settled at the aggregator: settle it there (reverts, such as
            // NotTimedOut or AggregationComplete, are the status check's to interpret).
            try verdikta.finalizeEvaluationTimeout(requestId) {
                (v, justification, ok) = verdikta.getEvaluation(requestId);
            } catch {}
        }
        if (!ok) {
            (bool complete, , , , , , , , , ) = verdikta.getAggregationStatus(requestId);
            require(complete, "evaluation not ready");
        }
    }

    /// @dev The oracle settings a request is sent with now, as BountyEscrow._effectiveOracle:
    ///      `fee` (the listing's maxOracleFee, or its disputeMaxOracleFee for a dispute) clamped
    ///      to the aggregator's live ceiling, and the base cost kept below it (the keeper
    ///      requires base < fee; without this a lowered ceiling would make every request
    ///      revert). alpha, scaling and class unchanged.
    function _effectiveOracle(StakeAttestation.OracleParams storage s, uint256 fee, IVerdiktaAggregator verdikta)
        private view returns (StakeAttestation.OracleParams memory o)
    {
        o = s;
        fee = ClaimRules.effectiveFee(fee, verdikta.maxOracleFee());
        o.maxOracleFee = fee;
        if (o.estimatedBaseCost >= fee) o.estimatedBaseCost = fee > 0 ? fee - 1 : 0;
    }

    /// @dev Design §13.3 with erratum E2: [the listing's archive (listingCid, or disputeCid for
    ///      a dispute), the claim's bcid, the bcids of the most recent MAX_PRIOR_FINDINGS valid
    ///      claims on this listing, oldest first]. At most 10, the aggregator's MAX_CID_COUNT.
    ///      Every entry passed the CID shape check when stored.
    function _requestCids(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        string storage archiveCid,
        uint256[] storage prior,
        string storage bcid
    ) private view returns (string[] memory cids) {
        uint256 n = prior.length;
        uint256 m = n < ClaimRules.MAX_PRIOR_FINDINGS ? n : ClaimRules.MAX_PRIOR_FINDINGS;
        cids = new string[](2 + m);
        cids[0] = archiveCid;
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
    ///      and strips it before any model sees the prompt. A claim round's addendum is this
    ///      line alone; a dispute's adds a LF and the E2 dispute line, "verdikta-dispute:
    ///      <statementCid>" (at most 476 bytes in all). Both match the common package's
    ///      formatDisclosureLine and formatDisputeLine byte for byte. Reads the reveal's keys.
    function _disclosureLine(StakeAttestation.Claim storage c) private view returns (string memory) {
        return string.concat(
            "verdikta-disclosure: ",
            Strings.toHexString(uint256(c.archiveHash), 32), " ",
            Strings.toHexString(uint256(c.ciphertextSha256), 32), " ",
            c.ciphertextCid, " ",
            Strings.toHexString(uint128(c.contentKey), 16), " ",
            Strings.toHexString(uint256(c.ephemeralKey), 32)
        );
    }
}
