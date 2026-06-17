const { Router } = require('express');
const { handleWebhookEvent } = require('../services/syncService');
const { logger, redact } = require('../services/logger');

const router = Router();

router.post('/webhook', async (req, res) => {
  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];
  const resourceUri = req.headers['x-goog-resource-uri'];

  // Extract calendar ID from URI: .../calendars/<encoded-id>/events?...
  const uriMatch = resourceUri?.match(/\/calendars\/([^/]+)\/events/);
  const calendarId = uriMatch ? decodeURIComponent(uriMatch[1]) : null;

  logger.info(`[webhook] Received Google Calendar ping — state: ${resourceState ?? '(missing)'}`);
  logger.debug(`[webhook] Parsed IDs — ${redact(channelId, 'channel')}, ${redact(calendarId, 'calendar')}`);
  logger.debug(`[webhook] Resource URI present: ${Boolean(resourceUri)}`);

  res.sendStatus(200);

  try {
    await handleWebhookEvent(channelId, resourceState, calendarId);
  } catch (err) {
    logger.error('[webhook] Error handling event:', err.message);
  }
});

module.exports = router;
