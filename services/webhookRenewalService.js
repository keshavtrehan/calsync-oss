require('dotenv').config({ quiet: true });

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');
const { getAuthenticatedClient } = require('./googleAuth');
const { writeLog } = require('./syncService');
const { logger, redact } = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function renewExpiringWebhooks() {
  logger.info('[webhookRenewal] Checking for expiring webhook channels...');

  if (!process.env.WEBHOOK_URL) {
    logger.error('[webhookRenewal] WEBHOOK_URL is not set — skipping renewal');
    return;
  }

  const { data: rules, error: rulesError } = await supabase
    .from('sync_rules')
    .select('source_calendar_id');

  if (rulesError) {
    logger.error('[webhookRenewal] Failed to query sync rules:', rulesError.message);
    return;
  }

  const sourceCalendarIds = [...new Set((rules ?? []).map((rule) => rule.source_calendar_id).filter(Boolean))];
  if (!sourceCalendarIds.length) {
    logger.info('[webhookRenewal] No source calendars found in sync rules.');
    return;
  }

  // Query source calendars with no channel expiry, or expiring within the next 2 days
  const twoDaysFromNow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  const { data: calendars, error: calError } = await supabase
    .from('calendars')
    .select('*')
    .in('id', sourceCalendarIds)
    .or(`webhook_expiry.is.null,webhook_expiry.lt.${twoDaysFromNow}`);

  if (calError) {
    logger.error('[webhookRenewal] Failed to query expiring calendars:', calError.message);
    return;
  }

  if (!calendars?.length) {
    logger.info('[webhookRenewal] No expiring channels found.');
    return;
  }

  logger.info(`[webhookRenewal] Found ${calendars.length} expiring channel(s)`);

  for (const calendar of calendars) {
    try {
      // Fetch the associated google account
      const { data: accounts, error: accError } = await supabase
        .from('google_accounts')
        .select('*')
        .eq('id', calendar.google_account_id)
        .limit(1);

      if (accError) throw new Error(`Failed to fetch google account: ${accError.message}`);
      if (!accounts?.length) throw new Error(`No google account found for calendar: ${calendar.id}`);

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
        logger.info(`[webhookRenewal] Access token refreshed for ${redact(account.id, 'account')}`);
      }

      // Register a new watch channel with a fresh channel ID
      const gcal = google.calendar({ version: 'v3', auth: client });
      const newChannelId = `calsync-${randomUUID()}`;

      const response = await gcal.events.watch({
        calendarId: calendar.calendar_id,
        requestBody: {
          id: newChannelId,
          type: 'web_hook',
          address: process.env.WEBHOOK_URL,
        },
      });

      const { id: returnedChannelId, expiration } = response.data;
      const newExpiry = new Date(parseInt(expiration)).toISOString();

      // Update calendars table with new channel ID and expiry
      const { error: updateError } = await supabase
        .from('calendars')
        .update({
          webhook_channel_id: returnedChannelId,
          webhook_expiry: newExpiry,
        })
        .eq('id', calendar.id);

      if (updateError) throw new Error(`Failed to update calendars table: ${updateError.message}`);

      const message = `Webhook renewed for "${calendar.label}" — new expiry: ${newExpiry}`;
      logger.info(`[webhookRenewal] Webhook renewed — ${redact(calendar.id, 'calendar')}, expiry: ${newExpiry}`);
      await writeLog(null, 'webhook_renewed', null, null, message);

    } catch (err) {
      logger.error(`[webhookRenewal] Failed to renew channel for ${redact(calendar.id, 'calendar')}: ${err.message}`);
      await writeLog(null, 'error', null, null,
        `Webhook renewal failed for calendar "${calendar.label}"`, err.message);
      // continue to next calendar
    }
  }

  logger.info('[webhookRenewal] Renewal check complete.');
}

module.exports = { renewExpiringWebhooks };
