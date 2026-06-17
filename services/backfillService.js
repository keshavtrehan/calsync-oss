require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./googleAuth');
const { handleActiveEvent, writeLog } = require('./syncService');
const { describeSyncWindow, getSyncWindow } = require('./syncWindow');
const { logger, redact } = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runBackfill(syncRuleId) {
  logger.info(`[backfillService] Starting backfill for ${redact(syncRuleId, 'rule')}`);

  try {
    await writeLog(syncRuleId, 'backfill_started', null, null, `Backfill started for sync rule ${syncRuleId}`);

    // Fetch sync rule with source and target calendar rows joined
    const { data: rules, error: ruleError } = await supabase
      .from('sync_rules')
      .select('*, target_calendar:target_calendar_id(*), source_calendar:source_calendar_id(*)')
      .eq('id', syncRuleId)
      .limit(1);

    if (ruleError) throw new Error(`Failed to fetch sync rule: ${ruleError.message}`);
    if (!rules?.length) throw new Error(`Sync rule not found: ${syncRuleId}`);

    const rule = rules[0];
    if (!rule.is_active) throw new Error(`Sync rule "${rule.label}" is not active — skipping backfill`);

    const sourceCalendar = rule.source_calendar;

    // Fetch google account for source calendar
    const { data: accounts, error: accError } = await supabase
      .from('google_accounts')
      .select('*')
      .eq('id', sourceCalendar.google_account_id)
      .limit(1);

    if (accError) throw new Error(`Failed to fetch google account: ${accError.message}`);
    if (!accounts?.length) throw new Error(`No google account found for calendar: ${sourceCalendar.id}`);

    const account = accounts[0];

    // Authenticate and persist refreshed token if needed
    const { client, updatedCredentials } = await getAuthenticatedClient(account);
    if (updatedCredentials) {
      const { error: tokenError } = await supabase
        .from('google_accounts')
        .update({
          access_token: updatedCredentials.access_token,
          token_expiry: updatedCredentials.token_expiry,
        })
        .eq('id', account.id);
      if (tokenError) throw new Error(`Failed to persist refreshed token: ${tokenError.message}`);
      logger.info(`[backfillService] Access token refreshed for ${redact(account.id, 'account')}`);
    }

    const gcal = google.calendar({ version: 'v3', auth: client });

    // First pass: fetch event instances from 7 days ago with singleEvents: true
    // This expands recurring events into individual instances, preventing old master records from being synced
    const { timeMax } = getSyncWindow();
    const syncWindow = describeSyncWindow();
    logger.info(`[backfillService] Fetching events from ${redact(sourceCalendar.id, 'calendar')} (timeMin: ${syncWindow.timeMin}, timeMax: ${syncWindow.timeMax}, singleEvents: true)`);

    let events = [];
    let nextSyncToken = null;
    let pageToken = undefined;

    do {
      const response = await gcal.events.list({
        calendarId: sourceCalendar.calendar_id,
        singleEvents: true,
        orderBy: 'startTime',
        timeMin: syncWindow.timeMin,
        timeMax: syncWindow.timeMax,
        showDeleted: true,
        maxResults: 250,
        conferenceDataVersion: 1,
        ...(pageToken && { pageToken }),
      });

      const items = response.data.items ?? [];
      events.push(...items);
      nextSyncToken = response.data.nextSyncToken ?? null;

      const newPageToken = response.data.nextPageToken ?? undefined;
      if (newPageToken && newPageToken === pageToken) break;
      pageToken = newPageToken;
    } while (pageToken);

    logger.info(`[backfillService] Fetched ${events.length} event(s)`);

    // Save nextSyncToken so subsequent webhook processing is incremental
    if (nextSyncToken) {
      const { error: tokenSaveError } = await supabase
        .from('calendars')
        .update({ sync_token: nextSyncToken })
        .eq('id', sourceCalendar.id);
      if (tokenSaveError) logger.error(`[backfillService] Failed to save sync token: ${tokenSaveError.message}`);
      else logger.debug(`[backfillService] Sync token saved for ${redact(sourceCalendar.id, 'calendar')}`);
    } else {
      logger.warn('[backfillService] WARNING: No nextSyncToken returned after first pass — subsequent webhook processing will use timeMin fallback');
    }

    // Second pass: fetch future recurring instances expanded as single events
    let recurringEvents = [];
    logger.debug('[backfillService] Fetching future recurring instances...');
    try {
      pageToken = undefined;
      do {
        const response = await gcal.events.list({
          calendarId: sourceCalendar.calendar_id,
          singleEvents: true,
          orderBy: 'startTime',
          timeMin: new Date().toISOString(),
          timeMax: timeMax.toISOString(),
          showDeleted: false,
          maxResults: 250,
          conferenceDataVersion: 1,
          ...(pageToken && { pageToken }),
        });
        const items = response.data.items ?? [];
        recurringEvents.push(...items);
        const nextPageToken = response.data.nextPageToken ?? undefined;
        if (nextPageToken && nextPageToken === pageToken) break;
        pageToken = nextPageToken;
      } while (pageToken);
      logger.info(`[backfillService] Found ${recurringEvents.length} future recurring instances`);
    } catch (err) {
      logger.error(`[backfillService] Second pass failed — continuing with first pass only: ${err.message}`);
      recurringEvents = [];
    }

    // Merge and deduplicate by event ID, then filter cancelled
    const eventMap = new Map();
    for (const event of events) eventMap.set(event.id, event);
    for (const event of recurringEvents) {
      if (!eventMap.has(event.id)) eventMap.set(event.id, event);
    }
    const allEvents = [...eventMap.values()].filter(e => e.status !== 'cancelled');
    logger.info(`[backfillService] Processing ${allEvents.length} merged and deduplicated event(s)`);

    // Process each event — handleActiveEvent handles duplicate prevention
    let count = 0;
    for (const event of allEvents) {
      if (event.status === 'cancelled') continue;
      try {
        await handleActiveEvent(event, rule, rule.target_calendar);
        count++;
      } catch (err) {
        logger.error(`[backfillService] Error processing event ${redact(event.id, 'event')}: ${err.message}`);
        await writeLog(syncRuleId, 'error', event.id, null,
          `Backfill error for event "${event.summary ?? event.id}"`, err.message);
      }
    }

    logger.info(`[backfillService] Backfill complete — ${count} event(s) processed`);
    await writeLog(syncRuleId, 'backfill_complete', null, null,
      `Backfill complete — ${count} event(s) processed for rule "${rule.label}"`);

  } catch (err) {
    logger.error(`[backfillService] Backfill failed for ${redact(syncRuleId, 'rule')}: ${err.message}`);
    await writeLog(syncRuleId, 'error', null, null,
      `Backfill failed for sync rule ${syncRuleId}`, err.message);
  }
}

module.exports = { runBackfill };
