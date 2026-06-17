require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const { runBackfill } = require('./backfillService');
const { runCleanup } = require('./cleanupService');
const { logger, redact } = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function handleSyncRuleChange(oldRow, newRow) {
  const wasActive = oldRow.is_active;
  const isNowActive = newRow.is_active;

  if (wasActive === true && isNowActive === false) {
    logger.info(`[lifecycleService] Rule "${newRow.label}" deactivated — running cleanup`);
    await runCleanup(newRow.id);

    // Clear sync_token so next activation starts a fresh backfill from 7 days ago
    const { error } = await supabase
      .from('calendars')
      .update({ sync_token: null })
      .eq('id', newRow.source_calendar_id);

    if (error) logger.error(`[lifecycleService] Failed to clear sync token: ${error.message}`);
    else logger.info(`[lifecycleService] Sync token cleared for ${redact(newRow.source_calendar_id, 'calendar')}`);

  } else if (wasActive === false && isNowActive === true) {
    logger.info(`[lifecycleService] Rule "${newRow.label}" activated — running backfill`);
    await runBackfill(newRow.id);

  } else {
    logger.debug(`[lifecycleService] No is_active change for rule "${newRow.label}" — nothing to do`);
  }
}

module.exports = { handleSyncRuleChange };
