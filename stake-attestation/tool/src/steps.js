// The points of the two long flows, in order. Each is a place a process can die; test/crash.test.js kills a
// real process at every one and resumes it. Reported through `onStep` with the name alone.
export const COMMIT_STEPS = Object.freeze([
  'prepare:archive',
  'prepare:keys',
  'prepare:ciphertext',
  'prepare:saved',
  'commit:signed',
  'commit:sent',
  'commit:mined',
  'commit:saved',
  'disclose:pinned',
  'disclose:read-back',
  'disclose:cid-saved',
  'disclose:signed',
  'disclose:sent',
  'disclose:mined',
  'disclose:saved',
]);

export const REVEAL_STEPS = Object.freeze([
  'reveal:verified',
  'reveal:pinned',
  'reveal:read-back',
  'reveal:cid-saved',
  'reveal:signed',
  'reveal:sent',
  'reveal:mined',
  'reveal:saved',
]);
