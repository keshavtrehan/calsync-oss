require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const { randomUUID } = require('crypto');
const { getAuthenticatedClient } = require('../services/googleAuth');

const TARGET_CALENDAR_ID = process.argv[2];

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is not set`);
}

async function main() {
  if (!TARGET_CALENDAR_ID) throw new Error('Usage: node scripts/registerWebhook.js <calendar-id>');
  requireEnv('SUPABASE_URL', process.env.SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);
  requireEnv('WEBHOOK_URL', process.env.WEBHOOK_URL);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Fetch the calendar row
  const { data: calendars, error: calError } = await supabase
    .from('calendars')
    .select('*')
    .eq('calendar_id', TARGET_CALENDAR_ID)
    .limit(1);

  if (calError) throw new Error(`Failed to fetch calendar: ${calError.message}`);
  if (!calendars.length) throw new Error(`No calendar row found for calendar_id: ${TARGET_CALENDAR_ID}`);

  const calendar = calendars[0];
  console.log(`Found calendar: "${calendar.label}" (${calendar.calendar_id})`);
  console.log(`Current webhook_channel_id in DB: ${calendar.webhook_channel_id ?? '(none)'}`);
  console.log(`Current webhook_expiry in DB:     ${calendar.webhook_expiry ?? '(none)'}\n`);

  // Fetch the associated google account
  const { data: accounts, error: accError } = await supabase
    .from('google_accounts')
    .select('*')
    .eq('id', calendar.google_account_id)
    .limit(1);

  if (accError) throw new Error(`Failed to fetch google account: ${accError.message}`);
  if (!accounts.length) throw new Error(`No google_account found for id: ${calendar.google_account_id}`);

  const account = accounts[0];
  console.log(`Using account: ${account.email}`);

  // Authenticate
  const { client, updatedCredentials } = await getAuthenticatedClient(account);

  if (updatedCredentials) {
    const { error: tokenError } = await supabase
      .from('google_accounts')
      .update({
        access_token: updatedCredentials.access_token,
        token_expiry: updatedCredentials.token_expiry,
      })
      .eq('id', account.id);

    if (tokenError) throw new Error(`Failed to update access token: ${tokenError.message}`);
    console.log('Access token refreshed and saved to google_accounts.');
  }

  // Register the webhook channel
  const gcal = google.calendar({ version: 'v3', auth: client });
  const channelId = `calsync-${randomUUID()}`;

  const response = await gcal.events.watch({
    calendarId: TARGET_CALENDAR_ID,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: process.env.WEBHOOK_URL,
    },
  });

  const { id: returnedChannelId, expiration } = response.data;
  const webhookExpiry = new Date(parseInt(expiration)).toISOString();

  // Save channel ID and expiry back to Supabase
  const { error: updateError } = await supabase
    .from('calendars')
    .update({
      webhook_channel_id: returnedChannelId,
      webhook_expiry: webhookExpiry,
    })
    .eq('id', calendar.id);

  if (updateError) throw new Error(`Failed to update calendars table: ${updateError.message}`);

  console.log('\nWebhook registered successfully.');
  console.log(`  Channel ID:     ${returnedChannelId}`);
  console.log(`  Webhook URL:    ${process.env.WEBHOOK_URL}`);
  console.log(`  Expires at:     ${webhookExpiry}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
