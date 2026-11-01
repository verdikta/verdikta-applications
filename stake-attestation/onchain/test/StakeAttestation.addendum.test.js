// The reveal's addendum against @verdikta/common (build node C4, erratum E1): the line
// StakeAttestation.reveal writes is, byte for byte, the line of C4's committed vectors and what
// common's formatDisclosureLine writes; common's parser reads it back; and common's disclosure
// gate accepts it against the key the listing stores, so every arbiter's check passes on what
// the contract emits.
//
// test/fixtures/disclosure-vectors.v1.json is copied verbatim from verdikta-common
// test/fixtures/code-review/disclosure-vectors.v1.json at commit
// 49a99faa4e4fbea1756fb307d22308ea9e45ea46 (branch claude/stake-attestation; the file last
// changed in 7b6dc79, node C4). The npm package does not ship it. Its sha256 is pinned below,
// so an edit here is visible; refresh both together from common.
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { codeReview } = require("@verdikta/common");
const H = require("./helpers/claims");

const VECTORS_PATH = path.join(__dirname, "fixtures", "disclosure-vectors.v1.json");
const VECTORS_SHA256 = "0xcb60eefc2edeb350bbfaf70e6b1d56a1345654fbb76838f6718b72e43e8e8c48";
const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf8"));

// A { pattern, length } plaintext is byte i = (7i + 3) mod 256 (the file's note).
function plaintextOf(entry) {
  if (entry.plaintext.utf8 !== undefined) return Buffer.from(entry.plaintext.utf8, "utf8");
  const out = Buffer.alloc(entry.plaintext.length);
  for (let i = 0; i < out.length; i++) out[i] = (7 * i + 3) % 256;
  return out;
}

// Commit, disclose and reveal one claim with the vector's commitments and keys; return the addendum.
async function addendumFor(sa, aggregator, maker, hunter, disclosureKey, fields) {
  const id = await H.openListing(sa, maker, H.params({ artifact: H.atCommit(H.freshCommit()), disclosureKey }));
  const { claimId } = await H.claimAs(sa, hunter, id, {
    archive: fields.archiveSha256, ct: fields.ciphertextSha256, cid: fields.ciphertextCid,
  });
  const { requestId } = await H.revealAs(sa, hunter, claimId, { ck: fields.contentKey, ek: fields.ephemeralKey });
  return { addendum: (await aggregator.requestParams(requestId)).addendum, listingId: id };
}

const fieldsOf = (e) => ({
  archiveSha256: e.archiveSha256,
  ciphertextSha256: e.ciphertextSha256,
  ciphertextCid: e.ciphertextCid,
  contentKey: e.contentKey,
  ephemeralKey: e.ephemeralKey,
});

describe("StakeAttestation: the reveal addendum against @verdikta/common (C4, erratum E1)", function () {
  it("the copied vector file is the one at the recorded common commit", function () {
    expect(ethers.sha256(fs.readFileSync(VECTORS_PATH))).to.equal(VECTORS_SHA256);
    expect(vectors.version).to.equal(1);
    expect(vectors.deterministic.length).to.be.at.least(4);
  });

  for (const entry of vectors.deterministic) {
    it(`deterministic vector "${entry.name}": the addendum is the vector's line byte for byte, and common parses and verifies it`, async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(H.deploy);
      const makerKey = ethers.hexlify(Buffer.from(vectors.maker.publicKeyBase64, "base64"));
      expect(ethers.hexlify(codeReview.parseDisclosureKey(vectors.maker.recipient))).to.equal(makerKey);
      const { addendum, listingId } = await addendumFor(sa, aggregator, maker, hunter, makerKey, fieldsOf(entry));

      expect(addendum).to.equal(entry.line);
      expect(Buffer.from(addendum, "utf8").equals(Buffer.from(entry.line, "utf8"))).to.equal(true);
      expect(addendum).to.equal(codeReview.formatDisclosureLine(fieldsOf(entry)));
      const parsed = codeReview.parseDisclosureLine(addendum);
      expect(parsed.ok).to.equal(true);
      expect(parsed.fields).to.deep.equal(fieldsOf(entry));
      // The whole addendum is the line and nothing else: stripping leaves no text for a model.
      expect(codeReview.stripAddendum(addendum).text).to.equal("");

      // The gate every arbiter runs passes against the key as the listing stores it. The file
      // keeps ciphertexts up to 4 KiB; a larger one is re-derived (encryption is deterministic)
      // and must hash to the vector's commitment.
      const plaintext = plaintextOf(entry);
      const ciphertext = entry.ciphertextBase64 !== undefined
        ? Buffer.from(entry.ciphertextBase64, "base64")
        : codeReview.encryptForDisclosure(plaintext, vectors.maker.recipient, fieldsOf(entry));
      expect(ciphertext.length).to.equal(entry.ciphertextLength);
      expect(codeReview.disclosureSha256(ciphertext)).to.equal(entry.ciphertextSha256);
      const gate = codeReview.verifyDisclosure({
        plaintext,
        ciphertext,
        disclosureKey: ethers.getBytes((await sa.getListing(listingId)).disclosureKey),
        ...parsed.fields,
      });
      expect(gate).to.include({ ok: true, gate: "disclosure" });
    });
  }

  it("C4's contractLine vector (P2b's hard-coded line) is what common formats", async function () {
    const { sa, aggregator, maker, hunter } = await loadFixture(H.deploy);
    const { fields, line } = vectors.contractLine;
    expect(codeReview.formatDisclosureLine(fields)).to.equal(line);
    const { addendum } = await addendumFor(sa, aggregator, maker, hunter, "0x" + "a1".repeat(32), fields);
    expect(addendum).to.equal(line);
  });

  it("a disclosure made now with common's own functions round-trips through the contract", async function () {
    const { sa, aggregator, maker, hunter } = await loadFixture(H.deploy);
    const { recipient } = codeReview.generateDisclosureKeyPair();
    const plaintext = ethers.toUtf8Bytes("a fresh claim archive");
    const secrets = codeReview.generateDisclosureSecrets();
    const ciphertext = codeReview.encryptForDisclosure(plaintext, recipient, secrets);
    const fields = {
      archiveSha256: codeReview.disclosureSha256(plaintext),
      ciphertextSha256: codeReview.disclosureSha256(ciphertext),
      ciphertextCid: "bafkrei" + "a".repeat(52),
      contentKey: secrets.contentKey,
      ephemeralKey: secrets.ephemeralKey,
    };
    const key = ethers.hexlify(codeReview.parseDisclosureKey(recipient));
    const { addendum } = await addendumFor(sa, aggregator, maker, hunter, key, fields);
    expect(addendum).to.equal(codeReview.formatDisclosureLine(fields));
    const parsed = codeReview.parseDisclosureLine(addendum);
    expect(codeReview.verifyDisclosure({ plaintext, ciphertext, disclosureKey: recipient, ...parsed.fields }).ok).to.equal(true);
  });
});
