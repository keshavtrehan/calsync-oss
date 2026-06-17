const { google } = require('googleapis');
const { describeSyncWindow } = require('./syncWindow');
const { logger, redact } = require('./logger');

async function listEvents(client, calendarId, timeMin) {
  const calendar = google.calendar({ version: 'v3', auth: client });

  const defaultTimeMin = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const response = await calendar.events.list({
    calendarId,
    timeMin: timeMin ?? defaultTimeMin,
    showDeleted: true,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items ?? [];

  logger.debug(`[calendarService] Fetched ${events.length} event(s) from ${redact(calendarId, 'calendar')}`);

  return events;
}

async function listEventsSince(client, calendarId, syncToken) {
  const calendar = google.calendar({ version: 'v3', auth: client });
  const syncWindow = describeSyncWindow();

  const baseParams = syncToken
    ? { calendarId, syncToken, showDeleted: true, conferenceDataVersion: 1 }
    : {
        calendarId,
        timeMin: syncWindow.timeMin,
        timeMax: syncWindow.timeMax,
        showDeleted: true,
        maxResults: 250,
        conferenceDataVersion: 1,
      };

  const allEvents = [];
  let pageToken = undefined;
  let nextSyncToken = null;

  do {
    logger.debug(`[calendarService] Calling events.list — pageToken present: ${Boolean(pageToken)}`);

    const response = await calendar.events.list({ ...baseParams, ...(pageToken && { pageToken }) });

    const items = response.data.items ?? [];
    allEvents.push(...items);

    const newPageToken = response.data.nextPageToken ?? undefined;
    nextSyncToken = response.data.nextSyncToken ?? null;

    logger.debug(`[calendarService] Response — items: ${items.length}, nextPageToken: ${Boolean(newPageToken)}, nextSyncToken: ${Boolean(nextSyncToken)}`);

    if (newPageToken && newPageToken === pageToken) {
      logger.warn('[calendarService] WARNING: nextPageToken unchanged — breaking to prevent infinite loop.');
      break;
    }

    pageToken = newPageToken;
  } while (pageToken);

  logger.info(`[calendarService] Fetched ${allEvents.length} total event(s) from ${redact(calendarId, 'calendar')}`);

  return { events: allEvents, nextSyncToken };
}

module.exports = { listEvents, listEventsSince };
