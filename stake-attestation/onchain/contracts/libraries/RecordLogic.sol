// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {StakeAttestation} from "../StakeAttestation.sol";

/// @title RecordLogic
/// @notice Reads the record of an artifact hash (design §4.1, §13.4; build node P2e) out of
///         StakeAttestation's storage and returns it ABI-encoded, as an external (linked) library
///         for the EIP-170 size limit, as ClaimLogic is. StakeAttestation.recordData calls it;
///         the lens's recordByHash and recordPage decode what it returns.
/// @dev Runs by DELEGATECALL from StakeAttestation, on its storage (the pointers it passes); a
///      view: it changes nothing. It reads storage directly, a few slots per entry, rather than
///      through getListing / getClaim, which copy whole structs (strings, the known-issue ids and
///      the allowlist): that is what keeps a record of a few hundred claims inside one call.
///      Cost: O(listings in the page) plus O(items in the page) storage reads.
///
///      Paging. `page` is [listingOffset, listingLimit, itemOffset, itemLimit]: the listings
///      [listingOffset, listingOffset + listingLimit) of the hash that opened, in opening order
///      (a listing never funded has no stake and no claims, and is not on the record); and of
///      each item list (the valid findings, the bad-disclosure flags) the entries [itemOffset,
///      itemOffset + itemLimit) of its concatenation over those listings, in listing order and
///      then settlement order (findings) or flag order (flags). Totals (findingCount, flagCount,
///      the summed history) are over the page's listings; listingCount is the hash's. Limits
///      saturate, so type(uint256).max means "to the end".
library RecordLogic {
    function record(
        mapping(uint256 => StakeAttestation.Listing) storage listings,
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        mapping(uint256 => uint256[]) storage valid,
        mapping(uint256 => uint256[]) storage flagged,
        uint256[] storage ids, // the hash's opened listings (StakeAttestation._openedByHash)
        bytes32 artifactHash,
        uint256[4] memory page
    ) external view returns (bytes memory) {
        StakeAttestation.Record memory r;
        r.artifactHash = artifactHash;
        uint256 n = ids.length;
        r.listingCount = n;
        // Every listing of a hash has its kind: the hash commits to it (artifactHashOf).
        if (n != 0) r.kind = listings[ids[0]].artifactKind;

        (uint256 from, uint256 to) = _window(n, page[0], page[1]);
        uint256 count = to - from;
        uint256[] memory pageIds = new uint256[](count);
        r.listings = new StakeAttestation.ListingRecord[](count);
        uint256 active;
        for (uint256 i = 0; i < count; ) {
            uint256 id = ids[from + i];
            pageIds[i] = id;
            StakeAttestation.ListingRecord memory lr = r.listings[i]; // filled in place
            _listing(listings, id, lr);
            _add(r.history, lr.history);
            if (lr.state != StakeAttestation.ListingState.Closed) ++active;
            r.findingCount += valid[id].length;
            r.flagCount += flagged[id].length;
            unchecked { ++i; }
        }
        r.active = new uint256[](active);
        uint256 k;
        for (uint256 i = 0; i < count; ) {
            if (r.listings[i].state != StakeAttestation.ListingState.Closed) r.active[k++] = pageIds[i];
            unchecked { ++i; }
        }

        (uint256 s, uint256 e) = _window(r.findingCount, page[2], page[3]);
        r.findings = new StakeAttestation.Finding[](e - s);
        _findings(claims, valid, pageIds, s, e, r.findings);
        (s, e) = _window(r.flagCount, page[2], page[3]);
        r.flags = new StakeAttestation.FlagRecord[](e - s);
        _flags(claims, flagged, pageIds, s, e, r.flags);
        return abi.encode(r);
    }

    // ------------------------------------------------------------------
    //                               listings
    // ------------------------------------------------------------------

    /// @dev One listing's record, written into `lr` (already allocated, zero).
    function _listing(
        mapping(uint256 => StakeAttestation.Listing) storage listings,
        uint256 id,
        StakeAttestation.ListingRecord memory lr
    ) private view {
        StakeAttestation.Listing storage l = listings[id];
        lr.listingId = id;
        lr.maker = l.maker;
        lr.state = l.state;
        uint64 until = l.fundedUntil;
        lr.lapsed = until != 0 && block.timestamp >= until; // StakeAttestation.isLapsed
        lr.invited = l.allowlist.length != 0;
        lr.artifactChainId = l.artifactChainId;
        lr.artifactAddress = l.artifactAddress;
        lr.listedAt = l.listedAt;
        lr.openedAt = l.openedAt;
        lr.fundedUntil = until;
        lr.rolledAt = l.rolledAt;
        lr.closedAt = l.closedAt;
        for (uint256 a = 0; a < 4; ) {
            lr.awards[a] = l.awards[a];
            unchecked { ++a; }
        }
        lr.lowestClassCounted = l.lowestClassCounted;
        lr.bondWei = l.bondWei;
        lr.escrowWei = l.escrowWei;
        lr.owedWei = l.owedWei;
        lr.valueAtRiskUsd = l.valueAtRiskUsd;
        // Lineage (design §4.1): what this version fixed, and what fixed it.
        uint256 pred = l.predecessor;
        lr.predecessor = pred;
        if (pred != 0) lr.predecessorHash = listings[pred].artifactHash;
        uint256 succ = l.successor;
        lr.successor = succ;
        if (succ != 0) lr.successorHash = listings[succ].artifactHash;
        _history(l, lr.history);
    }

    /// @dev The listing's counters, written into `h` (already allocated, zero).
    function _history(StakeAttestation.Listing storage l, StakeAttestation.History memory h) private view {
        h.claims = l.claimsCommitted;
        h.pending = l.pendingClaims;
        h.released = l.releasedClaims;
        h.undisclosed = l.undisclosedClaims;
        h.unrevealed = l.unrevealedClaims;
        h.noVerdict = l.noVerdictClaims;
        h.disputes = l.disputesFiled;
        h.disputesHeld = l.disputesHeld;
        h.disputesOverturned = l.disputesOverturned;
        h.disputesNoVerdict = l.disputesNoVerdict;
        h.lateClaims = l.lateClaims;
        h.lateExpired = l.lateExpired;
        for (uint256 o = 0; o < 6; ) {
            h.outcomes[o] = l.outcomeCounts[o];
            h.lateOutcomes[o] = l.lateOutcomeCounts[o];
            unchecked { ++o; }
        }
    }

    /// @dev total += h, field by field.
    function _add(StakeAttestation.History memory total, StakeAttestation.History memory h) private pure {
        total.claims += h.claims;
        total.pending += h.pending;
        total.released += h.released;
        total.undisclosed += h.undisclosed;
        total.unrevealed += h.unrevealed;
        total.noVerdict += h.noVerdict;
        total.disputes += h.disputes;
        total.disputesHeld += h.disputesHeld;
        total.disputesOverturned += h.disputesOverturned;
        total.disputesNoVerdict += h.disputesNoVerdict;
        total.lateClaims += h.lateClaims;
        total.lateExpired += h.lateExpired;
        for (uint256 o = 0; o < 6; ) {
            total.outcomes[o] += h.outcomes[o];
            total.lateOutcomes[o] += h.lateOutcomes[o];
            unchecked { ++o; }
        }
    }

    // ------------------------------------------------------------------
    //                                items
    // ------------------------------------------------------------------

    /// @dev The entries [s, e) of the listings' valid findings, concatenated in listing order,
    ///      written into `out` (length e - s, already allocated).
    function _findings(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        mapping(uint256 => uint256[]) storage valid,
        uint256[] memory pageIds,
        uint256 s,
        uint256 e,
        StakeAttestation.Finding[] memory out
    ) private view {
        uint256 base; // the index, in the concatenation, of the current listing's first entry
        uint256 k;
        for (uint256 i = 0; i < pageIds.length && base < e; ) {
            uint256 id = pageIds[i];
            uint256[] storage list = valid[id];
            uint256 len = list.length;
            (uint256 j, uint256 end) = _slice(base, len, s, e);
            for (; j < end; ) {
                uint256 claimId = list[j];
                StakeAttestation.Claim storage c = claims[claimId];
                StakeAttestation.Finding memory f = out[k++];
                f.claimId = claimId;
                f.listingId = id;
                f.hunter = c.hunter;
                f.outcome = c.outcome;
                f.late = c.late;
                f.dispute = c.dispute;
                f.paidWei = c.paidWei;
                f.owedWei = c.owedWei;
                f.revealedAt = c.revealedAt;
                f.settledAt = c.settledAt;
                f.bcid = c.bcid;
                unchecked { ++j; }
            }
            base += len;
            unchecked { ++i; }
        }
    }

    /// @dev The entries [s, e) of the listings' flagged claims, concatenated in listing order,
    ///      written into `out` (length e - s, already allocated).
    function _flags(
        mapping(uint256 => StakeAttestation.Claim) storage claims,
        mapping(uint256 => uint256[]) storage flagged,
        uint256[] memory pageIds,
        uint256 s,
        uint256 e,
        StakeAttestation.FlagRecord[] memory out
    ) private view {
        uint256 base;
        uint256 k;
        for (uint256 i = 0; i < pageIds.length && base < e; ) {
            uint256 id = pageIds[i];
            uint256[] storage list = flagged[id];
            uint256 len = list.length;
            (uint256 j, uint256 end) = _slice(base, len, s, e);
            for (; j < end; ) {
                uint256 claimId = list[j];
                StakeAttestation.Claim storage c = claims[claimId];
                StakeAttestation.FlagRecord memory f = out[k++];
                f.claimId = claimId;
                f.listingId = id;
                f.late = c.late;
                f.state = c.state;
                f.outcome = c.outcome;
                f.disclosedAt = c.disclosedAt;
                f.revealedAt = c.revealedAt;
                f.judgedAt = c.judgedAt;
                unchecked { ++j; }
            }
            base += len;
            unchecked { ++i; }
        }
    }

    // ------------------------------------------------------------------
    //                               windows
    // ------------------------------------------------------------------

    /// @dev [from, to) = [offset, offset + limit) clipped to [0, n), without overflow.
    function _window(uint256 n, uint256 offset, uint256 limit) private pure returns (uint256 from, uint256 to) {
        if (offset >= n) return (n, n);
        from = offset;
        to = n - offset < limit ? n : offset + limit;
    }

    /// @dev The part of the window [s, e) that falls in a list occupying [base, base + len) of
    ///      the concatenation, as indices into that list ([j, end), empty when it misses).
    ///      Called with base < e.
    function _slice(uint256 base, uint256 len, uint256 s, uint256 e)
        private pure returns (uint256 j, uint256 end)
    {
        if (base + len <= s) return (0, 0);
        j = s > base ? s - base : 0;
        end = e - base < len ? e - base : len;
    }
}
