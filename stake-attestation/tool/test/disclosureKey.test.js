// Node P35 (claim test, item 4): the key a claim is encrypted to shows as a bytes32 on-chain and in the site's feed,
// and as an age recipient (age1…) in the listing archive. Before it pays, commit now names it in both forms, with the
// sentence the site uses that says they are one key (shared/src/disclosureKey.js), and the conversion is the one the
// arbiters' library reads: @verdikta/common's parseDisclosureKey takes the recipient back to the same 32 bytes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { DISCLOSURE_KEY_NOTE, disclosureRecipientOf } from '@verdikta/stake-attestation-shared/disclosure-key';

import { commitNotice } from '../src/index.js';
import { termsForNotice } from '../src/listing.js';
import { closeRpc } from './helpers/cli.js';
import { codeReview, makeClaimDir, makeWorld } from './helpers/world.js';

const hex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

let w;
before(async () => { w = await makeWorld(); });
after(async () => {
  await closeRpc(w);
  await w.close();
});

test('the conversion is @verdikta/common\'s, both ways, for keys common makes', () => {
  for (let i = 0; i < 50; i += 1) {
    const { recipient } = codeReview.generateDisclosureKeyPair();
    const bytes32 = hex(codeReview.parseDisclosureKey(recipient));
    assert.equal(disclosureRecipientOf(bytes32), recipient);
    assert.equal(hex(codeReview.parseDisclosureKey(disclosureRecipientOf(bytes32))), bytes32);
  }
});

test('the terms commit shows carry the key as the chain stores it and as an age recipient', () => {
  const { recipient } = codeReview.generateDisclosureKeyPair();
  const bytes32 = hex(codeReview.parseDisclosureKey(recipient));
  const listing = {
    listingId: 3n,
    spec: { repo: 'https://example.invalid/r', baseCommit: 'a'.repeat(40) },
    onChain: { state: 1n, maker: `0x${'11'.repeat(20)}`, bondWei: 1n, awards: [0n, 1n, 2n, 3n], lowestClassCounted: 3n, fixWindow: 0n, revealWindow: 1n, disputeWindow: 1n, allowlist: [], disclosureKey: bytes32 },
  };
  const t = termsForNotice(listing, 2n);
  assert.equal(t.disclosureKey, bytes32);
  assert.equal(t.disclosureRecipient, recipient);
  const text = commitNotice(t);
  assert.ok(text.includes(recipient), 'the age recipient');
  assert.ok(text.includes(bytes32), 'the bytes32');
  assert.ok(text.includes(DISCLOSURE_KEY_NOTE), 'and that they are one key');
});

test('before it pays, commit names the listing\'s key in both forms: the archive\'s recipient and the bytes32 on-chain', async () => {
  const l = await w.listing();
  const notices = [];
  await assert.rejects(w.hunter({ onNotice: (t) => notices.push(t) }).commit({ claimDir: makeClaimDir(), listingId: l.listingId }), (e) => e.code === 'NEEDS_ACKNOWLEDGEMENT');
  const text = notices.join('\n');
  const onchain = (await w.sa.getListing(l.listingId)).disclosureKey;
  assert.equal(onchain.toLowerCase(), l.params.disclosureKey.toLowerCase());
  const line = text.split('\n').find((x) => x.includes(l.recipient));
  assert.ok(line, `the notice names the archive's recipient ${l.recipient}`);
  assert.ok(line.includes(onchain), 'on the same line as the bytes32 the chain stores');
  assert.ok(text.includes(DISCLOSURE_KEY_NOTE));
});
