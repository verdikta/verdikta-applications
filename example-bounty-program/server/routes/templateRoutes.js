/**
 * Rubric templates for agents (public, no key): the same templates the create page
 * offers, ready for POST /api/jobs/create. See utils/rubricTemplates.js.
 *
 *   GET /api/templates        list
 *   GET /api/templates/:key   one template with its rubricJson
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { listTemplates, getTemplate } = require('../utils/rubricTemplates');

const USAGE = {
  byKey: 'POST /api/jobs/create with "rubricTemplate": "<key>" in place of rubricJson: the server fills in the template\'s exact rubric, and its recommended threshold and classId unless you send your own. Add "rubricTemplateVersion" to insist on a version (a 400 TEMPLATE_VERSION_CHANGED says when it moved on).',
  edited: 'To change a template, read GET /api/templates/<key>, edit its rubricJson and send that as rubricJson. POST /api/jobs/rubric/validate reports which template a draft matches.',
  description: 'The rubric says how work is judged; the description still has to say what to deliver. Templates are generic, so name the topic, audience, format and length in the description.',
};

router.get('/', (req, res) => {
  try {
    return res.json({ success: true, templates: listTemplates(), usage: USAGE });
  } catch (error) {
    logger.error('[templates] list error', { msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to list templates', details: error.message });
  }
});

router.get('/:key', (req, res) => {
  const template = getTemplate(req.params.key);
  if (!template) {
    const known = listTemplates();
    const service = known.find((t) => t.key === req.params.key && t.kind === 'service');
    return res.status(404).json({
      success: false,
      error: 'Template not found',
      code: 'UNKNOWN_TEMPLATE',
      details: service
        ? `${service.key} is a verdikta-discover work-order template, built from a work-order request by that skill: ${service.docs}`
        : `Known templates: ${known.filter((t) => t.kind === 'rubric').map((t) => t.key).join(', ')}`,
    });
  }
  return res.json({ success: true, template, usage: USAGE });
});

module.exports = router;
