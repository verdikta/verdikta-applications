// The maker's disclosure key (design §14; node P35): one X25519 public key, written two ways. A listing archive's
// stake.disclosureKey and stock age write it as an age recipient (age1…): bech32 (BIP 173) with the HRP "age" over the
// key's 32 bytes. StakeAttestation stores the same 32 bytes as a bytes32 (getListing's disclosureKey, which the site's
// feed relays). @verdikta/common's parseDisclosureKey reads a recipient; nothing in its public API writes one from the
// bytes, which the site and the hunter tool need to show both forms side by side, so the encoding is here, both ways,
// and each package's tests hold it to common's reading of keys common makes. Nothing of node in this file: the client
// bundles it.

/** What the site and the tool say beside the two forms (claim test, item 4). */
export const DISCLOSURE_KEY_NOTE = 'The age recipient (age1…) and the bytes32 the contract stores are one key in two encodings: '
  + 'the maker\'s X25519 public key, the one a claim is encrypted to.';

const HRP = 'age';
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
// the shape common's parseDisclosureKey takes: lowercase, "age1", 58 characters of data and checksum
const RECIPIENT = /^age1[ac-hj-np-z02-9]{58}$/;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

/** Regroups bits: 8 to 5 with padding, or 5 to 8 refusing any padding that is not zeros. */
function regroup(values, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const max = (1 << to) - 1;
  const keep = (1 << (from + to - 1)) - 1;
  for (const v of values) {
    acc = ((acc << from) | v) & keep;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max) !== 0) {
    return null;
  }
  return out;
}

/**
 * The age recipient of a bytes32, as stock age writes the same key.
 * @param {string} bytes32 - 0x and 64 hex digits, in either case
 * @returns {string} age1…
 * @throws {TypeError} for anything else
 */
export function disclosureRecipientOf(bytes32) {
  if (typeof bytes32 !== 'string' || !BYTES32.test(bytes32)) throw new TypeError('a disclosure key bytes32 is 0x and 64 hex digits');
  const bytes = [];
  for (let i = 2; i < 66; i += 2) bytes.push(Number.parseInt(bytes32.slice(i, i + 2), 16));
  const data = regroup(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(HRP), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${HRP}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`;
}

/**
 * The bytes32 of an age recipient: its 32 bytes as 0x and lowercase hex, the form getListing answers in.
 * @param {string} recipient - age1…, lowercase, its checksum valid
 * @returns {string}
 * @throws {TypeError} for anything else
 */
export function disclosureBytes32Of(recipient) {
  if (typeof recipient !== 'string' || !RECIPIENT.test(recipient)) throw new TypeError('an age recipient is age1 and 58 lowercase bech32 characters');
  const data = [...recipient.slice(HRP.length + 1)].map((c) => CHARSET.indexOf(c));
  if (polymod([...hrpExpand(HRP), ...data]) !== 1) throw new TypeError('the age recipient\'s checksum does not hold');
  const bytes = regroup(data.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== 32) throw new TypeError('the age recipient does not hold 32 bytes');
  return `0x${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
