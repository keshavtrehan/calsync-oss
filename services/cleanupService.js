require('dotenv').config({ quiet: true });

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { getAuthenticatedClient } = require('./googleAuth');
const { writeLog } = require('./syncService');
const { logger, redact } = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runCleanup(syncRuleId, cachedTargetCalendarId = null) {
  logger.info(`[cleanupService] Starting cleanup for ${redact(syncRuleId, 'rule')}`);

  try {
    // Try to fetch the sync rule — may not exist if the rule was deleted
    const { data: rules } = await supabase
      .from('sync_rules')
      .select('*, target_calendar:target_calendar_id(*)')
      .eq('id', syncRuleId)
      .limit(1);

    const ruleExists = rules?.length > 0;
    let targetCalendar = ruleExists ? rules[0].target_calendar : null;

    // If rule is gone, fall back to cachedTargetCalendarId
    if (!targetCalendar && cachedTargetCalendarId) {
      const { data: calendars } = await supabase
        .from('calendars')
        .select('*')
        .eq('id', cachedTargetCalendarId)
        .limit(1);
      targetCalendar = calendars?.[0] ?? null;
    }

    if (!targetCalendar) {
      logger.error(`[cleanupService] Cannot find target calendar for ${redact(syncRuleId, 'rule')} — skipping cleanup`);
      return;
    }

    // Use null as logRuleId if the sync rule no longer exists — avoids FK violation in sync_logs
    const logRuleId = ruleExists ? syncRuleId : null;

    // Fetch google account for target calendar
    const { data: accounts } = await supabase
      .from('google_accounts')
      .select('*')
      .eq('id', targetCalendar.google_account_id)
      .limit(1);

    if (!accounts?.length) {
      logger.error(`[cleanupService] No google account for ${redact(targetCalendar.id, 'targetCalendar')}`);
      return;
    }

    const { client } = await getAuthenticatedClient(accounts[0]);
    const gcal = google.calendar({ version: 'v3', auth: client });

    // Always query fresh — enables clean resume if a previous run failed partway through
    const { data: indexRows, error: indexError } = await supabase
      .from('event_sync_index')
      .select('*')
      .eq('sync_rule_id', syncRuleId);

    if (indexError) {
      logger.error(`[cleanupService] Failed to fetch event_sync_index: ${indexError.message}`);
      return;
    }

    if (!indexRows?.length) {
      logger.info(`[cleanupService] No events to clean up for ${redact(syncRuleId, 'rule')}`);
      await writeLog(logRuleId, 'cleanup_complete', null, null,
        `Cleanup complete — 0 events to remove for rule ${syncRuleId}`);
      return;
    }

    let count = 0;

    for (const row of indexRows) {
      try {
        // Delete from Google Calendar — 404/410 means already gone, treat as success
        try {
          await gcal.events.delete({
            calendarId: targetCalendar.calendar_id,
            eventId: row.target_event_id,
          });
        } catch (err) {
          if (err.code === 404 || err.code === 410) {
            logger.info(`[cleanupService] Event ${redact(row.target_event_id, 'targetEvent')} already gone (${err.code}) — continuing`);
          } else {
            throw err;
          }
        }

        // Delete index row regardless of Google delete outcome
        await supabase.from('event_sync_index').delete().eq('id', row.id);

        logger.debug(`[cleanupService] Cleaned up: ${redact(row.source_event_id, 'sourceEvent')} -> ${redact(row.target_event_id, 'targetEvent')}`);
        await writeLog(logRuleId, 'deleted', row.source_event_id, row.target_event_id,
          `Cleanup deleted target event ${row.target_event_id} from "${targetCalendar.label}"`);

        count++;
      } catch (err) {
        logger.error(`[cleanupService] Error cleaning up event ${redact(row.target_event_id, 'targetEvent')}: ${err.message}`);
        await writeLog(logRuleId, 'error', row.source_event_id, row.target_event_id,
          `Cleanup error for event ${row.target_event_id}`, err.message);
        // continue to next event
      }
    }

    logger.info(`[cleanupService] Cleanup complete — ${count} event(s) removed`);
    await writeLog(logRuleId, 'cleanup_complete', null, null,
      `Cleanup complete — ${count} event(s) removed for rule ${syncRuleId}`);

  } catch (err) {
    logger.error(`[cleanupService] Cleanup failed for ${redact(syncRuleId, 'rule')}: ${err.message}`);
    // writeLog uses null syncRuleId safely since it's nullable in sync_logs
    await writeLog(null, 'error', null, null,
      `Cleanup failed for sync rule ${syncRuleId}`, err.message);
  }
}

module.exports = { runCleanup };
