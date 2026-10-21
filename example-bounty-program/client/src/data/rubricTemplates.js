/**
 * Predefined Rubric Templates
 * Based on rubric-1 schema
 *
 * The templates live in shared/rubricTemplates.json, which the server also reads to
 * serve them to agents (GET /api/templates) and to create a bounty from one by key.
 * After changing a template, run `node scripts/registerRubricTemplates.js` in server/.
 *
 * Threshold is included in the rubric itself because it's part of the
 * evaluation specification - "what score is required to pass" is as much
 * part of the rubric as the criteria themselves.
 *
 * mutualWager settles one side of a mutual wager: two directed bounties, each paying the
 * other bettor only if that bettor's side wins and the bettor holds a live mirrored counter
 * bounty. The terms go in the Job Description (utils/mutualWagerTerms.js builds them); every
 * criterion is must-pass. v1 settled mainnet bounty #303 in October 2026. v2 added the
 * stale-page rule to integrity. v3 (security review of PR #106) fails closed without web
 * access and checks the counter's every terms line, word-for-word criteria, jury, oracle
 * settings and package link.
 *
 * questionWager (mutual-wager-v4) is the same two-bounty design for any question a published
 * value or fact settles (an official close, a reference rate, an official result): YES or NO
 * against a line, with https Resolution sources the jurors open. Its counter criteria are v3's.
 */

import templateData from '../../../shared/rubricTemplates.json' with { type: 'json' };

export const rubricTemplates = templateData.templates;

/**
 * Default values for new rubrics
 */
export const RUBRIC_DEFAULTS = {
  threshold: 80,
  classId: 128,
  version: "rubric-1"
};

/**
 * Get list of template options for UI
 */
export const getTemplateOptions = () => {
  return [
    { value: '', label: 'Create from Scratch' },
    ...Object.entries(rubricTemplates).map(([key, t]) => ({ value: key, label: `${t.icon} ${t.label}` }))
  ];
};

/**
 * Get a template by key
 * @param {string} key - Template key
 * @returns {Object|null} Complete template including threshold and classId
 */
export const getTemplate = (key) => {
  return rubricTemplates[key] || null;
};

/**
 * Get the threshold for a template (reads directly from template)
 * @param {string} templateKey - Template key
 * @returns {number} Threshold value
 */
export const getTemplateThreshold = (templateKey) => {
  const template = rubricTemplates[templateKey];
  return template?.threshold ?? RUBRIC_DEFAULTS.threshold;
};

/**
 * Get the classId for a template
 * @param {string} templateKey - Template key
 * @returns {number} Class ID
 */
export const getTemplateClassId = (templateKey) => {
  const template = rubricTemplates[templateKey];
  return template?.classId ?? RUBRIC_DEFAULTS.classId;
};

/**
 * Create a blank rubric structure (with defaults)
 */
export const createBlankRubric = () => {
  return {
    version: RUBRIC_DEFAULTS.version,
    title: "",
    threshold: RUBRIC_DEFAULTS.threshold,
    classId: RUBRIC_DEFAULTS.classId,
    criteria: [
      {
        id: "quality",
        label: "Overall Quality",
        must: false,
        weight: 1.0,
        instructions: "General quality assessment."
      }
    ],
    forbiddenContent: [
      "NSFW content",
      "Hate speech",
      "Copyright violations"
    ]
  };
};
