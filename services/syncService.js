require('dotenv').config({ quiet: true });

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { getAuthenticatedClient } = require('./googleAuth');
const { listEventsSince } = require('./calendarService');
const { transformEvent } = require('./transformService');
const { describeSyncWindow, isEventInSyncWindow } = require('./syncWindow');
const { logger, redact } = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Fetch a google account and return an authenticated client, persisting any refreshed token
async function getClientForAccount(accountId) {
  const { data: accounts, error } = await supabase
    .from('google_accounts')
    .select('*')
    .eq('id', accountId)
    .limit(1);

  if (error) throw new Error(`Failed to fetch google account ${accountId}: ${error.message}`);
  if (!accounts.length) throw new Error(`No google account found for id: ${accountId}`);

  const account = accounts[0];
  const { client, updatedCredentials } = await getAuthenticatedClient(account);

  if (updatedCredentials) {
    const { error: tokenError } = await supabase
      .from('google_accounts')
      .update({
        access_token: updatedCredentials.access_token,
        token_expiry: updatedCredentials.token_expiry,
      })
      .eq('id', account.id);

    if (tokenError) throw new Error(`Failed to persist refreshed token for account ${accountId}: ${tokenError.message}`);
    logger.info(`[syncService] Access token refreshed for ${redact(account.id, 'account')}`);
  }

  return client;
}

async function writeLog(syncRuleId, action, sourceEventId, targetEventId, message, errorDetail) {
  const { error } = await supabase.from('sync_logs').insert({
    sync_rule_id: syncRuleId ?? null,
    action,
    source_event_id: sourceEventId ?? null,
    target_event_id: targetEventId ?? null,
    message,
    error_detail: errorDetail ?? null,
  });

  if (error) logger.error(`[syncService] Failed to write sync log: ${error.message}`);
}

async function processEvent(sourceEvent, sourceCalendar) {
  // Find all active sync rules where this calendar is the source
  const { data: syncRules, error: rulesError } = await supabase
    .from('sync_rules')
    .select('*, target_calendar:target_calendar_id(*)')
    .eq('source_calendar_id', sourceCalendar.id)
    .eq('is_active', true);

  if (rulesError) throw new Error(`Failed to fetch sync rules: ${rulesError.message}`);
  if (!syncRules.length) {
    logger.info(`[syncService] No active sync rules for ${redact(sourceCalendar.id, 'calendar')}`);
    return;
  }

  for (const rule of syncRules) {
    const targetCalendar = rule.target_calendar;

    try {
      if (sourceEvent.status === 'cancelled') {
        await handleCancelledEvent(sourceEvent, rule, targetCalendar);
      } else {
        await handleActiveEvent(sourceEvent, rule, targetCalendar);
      }
    } catch (err) {
      logger.error(`[syncService] Error processing event ${redact(sourceEvent.id, 'event')} for rule "${rule.label}": ${err.message}`);
      await writeLog(rule.id, 'error', sourceEvent.id, null, `Error processing event for rule "${rule.label}"`, err.message);
    }
  }
}

async function handleActiveEvent(sourceEvent, rule, targetCalendar) {
  // Check if a copy already exists in the index
  const { data: indexRows, error: indexError } = await supabase
    .from('event_sync_index')
    .select('*')
    .eq('sync_rule_id', rule.id)
    .eq('source_event_id', sourceEvent.id)
    .limit(1);

  if (indexError) throw new Error(`Failed to query event_sync_index: ${indexError.message}`);

  const existingIndex = indexRows?.[0];
  const title = sourceEvent.summary ?? sourceEvent.id;

  if (!isEventInSyncWindow(sourceEvent)) {
    const syncWindow = describeSyncWindow();

    if (existingIndex) {
      const targetClient = await getClientForAccount(targetCalendar.google_account_id);
      const gcal = google.calendar({ version: 'v3', auth: targetClient });

      try {
        await gcal.events.delete({
          calendarId: targetCalendar.calendar_id,
          eventId: existingIndex.target_event_id,
        });
      } catch (err) {
        if (err.code === 404 || err.code === 410) {
          logger.info(`[syncService] Out-of-window target event already gone (${err.code}): ${redact(existingIndex.target_event_id, 'targetEvent')}`);
        } else {
          throw err;
        }
      }

      await supabase.from('event_sync_index').delete().eq('id', existingIndex.id);

      logger.info(`[syncService] Removed out-of-window event ${redact(sourceEvent.id, 'event')} from ${redact(targetCalendar.id, 'targetCalendar')}`);
      await writeLog(rule.id, 'deleted', sourceEvent.id, existingIndex.target_event_id,
        `Deleted "${title}" from target calendar "${targetCalendar.label}" because its start is outside sync window ${syncWindow.timeMin} to ${syncWindow.timeMax}`);
    } else {
      logger.info(`[syncService] Skipping out-of-window event ${redact(sourceEvent.id, 'event')} for rule "${rule.label}"`);
      await writeLog(rule.id, 'skipped', sourceEvent.id, null,
        `Skipped "${title}" because its start is outside sync window ${syncWindow.timeMin} to ${syncWindow.timeMax}`);
    }

    return;
  }

  const targetClient = await getClientForAccount(targetCalendar.google_account_id);
  const gcal = google.calendar({ version: 'v3', auth: targetClient });
  const transformed = transformEvent(sourceEvent, rule);

  if (existingIndex) {
    // Update existing target event
    const { data: updated } = await gcal.events.update({
      calendarId: targetCalendar.calendar_id,
      eventId: existingIndex.target_event_id,
      requestBody: transformed,
    });

    await supabase.from('event_sync_index').update({ last_synced_at: new Date().toISOString() })
      .eq('id', existingIndex.id);

    logger.info(`[syncService] Updated event ${redact(sourceEvent.id, 'event')} on ${redact(targetCalendar.id, 'targetCalendar')}`);
    await writeLog(rule.id, 'updated', sourceEvent.id, updated.data?.id ?? existingIndex.target_event_id,
      `Updated "${sourceEvent.summary ?? ''}" on target calendar "${targetCalendar.label}"`);
  } else {
    // Double-check index immediately before creating — guards against concurrent webhooks
    // both passing the first check before either has written the index row
    const { data: recheckRows, error: recheckError } = await supabase
      .from('event_sync_index')
      .select('*')
      .eq('sync_rule_id', rule.id)
      .eq('source_event_id', sourceEvent.id)
      .limit(1);

    if (recheckError) throw new Error(`Failed to recheck event_sync_index: ${recheckError.message}`);

    if (recheckRows?.length) {
      logger.info(`[syncService] Skipping create — index row appeared between checks for ${redact(sourceEvent.id, 'event')}`);
      await writeLog(rule.id, 'skipped', sourceEvent.id, recheckRows[0].target_event_id,
        `Skipped duplicate create for "${sourceEvent.summary ?? ''}" — concurrent webhook already created index row`);
      return;
    }

    // Create new target event
    const { data: created } = await gcal.events.insert({
      calendarId: targetCalendar.calendar_id,
      requestBody: transformed,
    });

    const targetEventId = created.id;

    // Upsert with onConflict — if a concurrent request already inserted, update instead of erroring
    await supabase.from('event_sync_index').upsert({
      sync_rule_id: rule.id,
      source_event_id: sourceEvent.id,
      target_event_id: targetEventId,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'source_event_id,sync_rule_id', ignoreDuplicates: false });

    logger.info(`[syncService] Created event ${redact(sourceEvent.id, 'event')} on ${redact(targetCalendar.id, 'targetCalendar')}`);
    await writeLog(rule.id, 'created', sourceEvent.id, targetEventId,
      `Created "${sourceEvent.summary ?? ''}" on target calendar "${targetCalendar.label}"`);
  }
}

async function handleCancelledEvent(sourceEvent, rule, targetCalendar) {
  const { data: indexRows, error: indexError } = await supabase
    .from('event_sync_index')
    .select('*')
    .eq('sync_rule_id', rule.id)
    .eq('source_event_id', sourceEvent.id)
    .limit(1);

  if (indexError) throw new Error(`Failed to query event_sync_index: ${indexError.message}`);

  if (!indexRows?.length) {
    logger.info(`[syncService] Cancelled event ${redact(sourceEvent.id, 'event')} has no index entry — skipping.`);
    await writeLog(rule.id, 'skipped', sourceEvent.id, null,
      `Cancelled event has no index entry for rule "${rule.label}" — nothing to delete`);
    return;
  }

  const indexRow = indexRows[0];
  const targetClient = await getClientForAccount(targetCalendar.google_account_id);
  const gcal = google.calendar({ version: 'v3', auth: targetClient });

  await gcal.events.delete({
    calendarId: targetCalendar.calendar_id,
    eventId: indexRow.target_event_id,
  });

  await supabase.from('event_sync_index').delete().eq('id', indexRow.id);

  logger.info(`[syncService] Deleted event ${redact(sourceEvent.id, 'event')} from ${redact(targetCalendar.id, 'targetCalendar')}`);
  await writeLog(rule.id, 'deleted', sourceEvent.id, indexRow.target_event_id,
    `Deleted cancelled event from target calendar "${targetCalendar.label}"`);
}

async function acquireLock(calendarId) {
  const { error } = await supabase
    .from('processing_locks')
    .insert({ calendar_id: calendarId });

  if (error) {
    // Unique constraint violation — another webhook is already processing this calendar
    if (error.code === '23505') return false;
    throw new Error(`Failed to acquire processing lock: ${error.message}`);
  }

  return true;
}

async function releaseLock(calendarId) {
  const { error } = await supabase
    .from('processing_locks')
    .delete()
    .eq('calendar_id', calendarId);

  if (error) logger.error(`[syncService] Failed to release processing lock for ${redact(calendarId, 'calendar')}: ${error.message}`);
}

async function handleWebhookEvent(channelId, resourceState, calendarId) {
  if (resourceState === 'sync') {
    logger.info('[syncService] Sync confirmation received, ignoring.');
    return;
  }

  if (resourceState !== 'exists') {
    logger.info(`[syncService] Unknown resourceState "${resourceState}", ignoring.`);
    return;
  }

  if (!calendarId) throw new Error('No calendar ID could be extracted from X-Goog-Resource-URI header.');
  if (!channelId) throw new Error('No channel ID could be extracted from X-Goog-Channel-ID header.');

  // Look up the calendar by calendar_id extracted from the resource URI, then
  // validate the channel before doing any sync work.
  const { data: calendars, error: calError } = await supabase
    .from('calendars')
    .select('*')
    .eq('calendar_id', calendarId)
    .limit(1);

  if (calError) throw new Error(`Failed to look up calendar for ${redact(calendarId, 'calendar')}: ${calError.message}`);

  if (!calendars.length) {
    logger.warn(`[syncService] Ignoring webhook for unknown ${redact(calendarId, 'calendar')}`);
    return;
  }

  const calendar = calendars[0];

  if (!calendar.webhook_channel_id) {
    logger.warn(`[syncService] Ignoring webhook for ${redact(calendar.id, 'calendar')} because no webhook channel is registered`);
    return;
  }

  if (calendar.webhook_channel_id !== channelId) {
    logger.warn(`[syncService] Ignoring webhook with channel mismatch for ${redact(calendar.id, 'calendar')}`);
    logger.debug(`[syncService] Stored ${redact(calendar.webhook_channel_id, 'channel')}, received ${redact(channelId, 'channel')}`);
    return;
  }

  // Acquire distributed lock — prevents concurrent webhooks from processing the same calendar
  const locked = await acquireLock(calendar.calendar_id);
  if (!locked) {
    logger.info(`[syncService] Skipping duplicate webhook — ${redact(calendar.id, 'calendar')} is already being processed.`);
    return;
  }

  try {
    logger.info(`[syncService] Webhook validated for "${calendar.label}" (${redact(calendar.id, 'calendar')})`);

    const sourceClient = await getClientForAccount(calendar.google_account_id);

    // Fetch events since last sync token, or fall back to the rolling sync window
    logger.debug(`[syncService] Sync token present: ${Boolean(calendar.sync_token)}`);
    let events;
    let nextSyncToken;

    try {
      ({ events, nextSyncToken } = await listEventsSince(sourceClient, calendar.calendar_id, calendar.sync_token ?? null));
    } catch (err) {
      if (calendar.sync_token && (err.code === 410 || err.status === 410)) {
        logger.warn(`[syncService] Sync token expired for ${redact(calendar.id, 'calendar')}; clearing token and retrying with rolling window.`);

        const { error: clearTokenError } = await supabase
          .from('calendars')
          .update({ sync_token: null })
          .eq('id', calendar.id);

        if (clearTokenError) throw new Error(`Failed to clear expired sync token: ${clearTokenError.message}`);

        await writeLog(null, 'skipped', null, null,
          `Expired sync token cleared for calendar "${calendar.label}"; retried with rolling sync window`);

        ({ events, nextSyncToken } = await listEventsSince(sourceClient, calendar.calendar_id, null));
      } else {
        throw err;
      }
    }
    logger.info(`[syncService] listEventsSince returned — events: ${events.length}, nextSyncToken: ${Boolean(nextSyncToken)}`);

    // Persist the new sync token back to Supabase
    if (nextSyncToken) {
      logger.debug(`[syncService] Attempting to save sync token to ${redact(calendar.id, 'calendar')}`);
      const { error: syncTokenError } = await supabase
        .from('calendars')
        .update({ sync_token: nextSyncToken })
        .eq('id', calendar.id);

      if (syncTokenError) {
        logger.error('[syncService] Failed to save sync token:', syncTokenError.message);
        throw new Error(`Failed to save sync token: ${syncTokenError.message}`);
      }
      logger.debug('[syncService] Sync token saved.');
    } else {
      logger.debug('[syncService] No nextSyncToken returned — skipping save.');
    }

    if (!events.length) {
      logger.info('[syncService] No changed events found.');
      return;
    }

    for (const event of events) {
      logger.debug(`[syncService] Processing event ${redact(event.id, 'event')} — status: ${event.status}`);
      await processEvent(event, calendar);
    }
  } finally {
    await releaseLock(calendar.calendar_id);
  }
}

module.exports = { handleWebhookEvent, handleActiveEvent, writeLog };
