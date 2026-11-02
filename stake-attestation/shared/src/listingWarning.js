// What every listing page says, and what the hunter tool (node P5) repeats before a commit (owner
// decision Q34): who reads a proof first, and that the code may exist elsewhere. Nothing of node in
// this file: the client bundles it.
export const LISTING_WARNING = Object.freeze({
  title: 'Before you send a proof',
  proofFirst:
    'A proof you commit here is encrypted to the staker\'s disclosure key, so the staker named on this listing reads ' +
    'it first, through the fix window. Nobody else reads it until the reveal, and the staker may not be the code\'s only maintainer.',
  elsewhere:
    'The code may exist elsewhere, in forks, copies and other deployments. This listing covers one version at one ' +
    'repository URL, and a finding here may also apply there; the people behind those copies are not told.',
});

/** The warning's two statements, in the order they are said. */
export const LISTING_WARNING_LINES = Object.freeze([LISTING_WARNING.proofFirst, LISTING_WARNING.elsewhere]);
