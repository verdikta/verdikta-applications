// The maker's disclosure key, in the browser, with @verdikta/common's disclosure module (design
// §14, build plan assumption A1): an age X25519 pair. The entry imported here,
// '@verdikta/common/src/codeReview/disclosure.js', and the three files it requires use nothing
// Node-only: @noble draws randomness from globalThis.crypto, so Vite bundles it as it is, with
// no shim. (The package's codeReview index is for Node: it reads files and uses node:crypto.)
//
// The private half (the identity) lives only in component state: it is shown and offered as a
// download once, used for decryption in this page, and never sent, logged or stored.
import disclosure from '@verdikta/common/src/codeReview/disclosure.js';

export const {
  DisclosureError,
  decryptDisclosure,
  disclosureRecipient,
  disclosureSha256,
  generateDisclosureKeyPair,
  parseDisclosureKey,
} = disclosure;

const IDENTITY_LINE = /^AGE-SECRET-KEY-1[0-9A-Z]+$/;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** The bytes32 StakeAttestation stores for an age recipient: the X25519 key it encodes. */
export function disclosureKeyBytes32(recipient) {
  return `0x${hex(parseDisclosureKey(recipient))}`;
}

/** The key file, in age-keygen's format, so stock `age -d -i <file>` reads it. */
export function keyFileText({ identity, recipient, createdAt = new Date() }) {
  const created = createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `# created: ${created}\n# public key: ${recipient}\n${identity}\n`;
}

export function keyFileName(recipient) {
  return `verdikta-disclosure-key-${recipient.slice(4, 12)}.txt`;
}

/** The AGE-SECRET-KEY-1 line of a key file (or a pasted key), or null. */
export function identityFromKeyFile(text) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (IDENTITY_LINE.test(line)) return line;
  }
  return null;
}

/** Saves bytes or text as a file through a download, locally: an object URL, revoked at once. */
export function saveLocally(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
