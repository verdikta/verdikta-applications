// The last line of defence on output: every string the CLI writes passes through a scrubber holding the live
// secrets, in the forms they could be printed in. Errors are built so they never hold a secret (errors.js);
// this is for the path nobody thought of.
const REDACTED = '[redacted]';
const HEX = /^(0x)?[0-9a-fA-F]+$/;

export function scrubber() {
  const forms = new Set();
  const scrub = (text) => {
    let out = String(text);
    for (const form of forms) out = out.split(form).join(REDACTED);
    return out;
  };
  scrub.add = (value) => {
    if (typeof value !== 'string' || value.length < 8) return;
    forms.add(value);
    if (HEX.test(value) && value.replace(/^0x/, '').length % 2 === 0) {
      const bare = value.replace(/^0x/, '');
      const bytes = Buffer.from(bare, 'hex');
      forms.add(bare);
      forms.add(bare.toLowerCase());
      forms.add(bare.toUpperCase());
      forms.add(bytes.toString('base64').replace(/=+$/, ''));
      forms.add(bytes.toString('base64url'));
    }
  };
  return scrub;
}

// Text a runner, a repository or a gateway wrote reaches a terminal: no escape sequences from it.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const plainText = (text) => String(text).replace(CONTROL, '');
