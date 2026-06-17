require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const { getAuthenticatedClient } = require('../services/googleAuth');
const { listEvents } = require('../services/calendarService');

const CALENDAR_ID = process.argv[2];

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is not set`);
}

async function main() {
  if (!CALENDAR_ID) throw new Error('Usage: node scripts/testListEvents.js <calendar-id>');
  requireEnv('SUPABASE_URL', process.env.SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: calendars, error: calendarError } = await supabase
    .from('calendars')
    .select('*')
    .eq('calendar_id', CALENDAR_ID)
    .limit(1);

  if (calendarError) throw new Error(`Failed to fetch calendar row: ${calendarError.message}`);
  if (!calendars.length) throw new Error(`No calendar row found for calendar_id: ${CALENDAR_ID}`);

  const calendar = calendars[0];

  const { data: accounts, error: accountError } = await supabase
    .from('google_accounts')
    .select('*')
    .eq('id', calendar.google_account_id)
    .limit(1);

  if (accountError) throw new Error(`Failed to fetch google_accounts: ${accountError.message}`);
  if (!accounts.length) throw new Error(`No google_accounts row found for calendar "${calendar.label}".`);

  const account = accounts[0];
  console.log(`Using calendar: "${calendar.label}"`);
  console.log(`Using account: ${account.email}`);

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
    console.log('Access token was refreshed and saved.');
  }

  const events = await listEvents(client, CALENDAR_ID);

  const preview = events.slice(0, 3);

  if (!preview.length) {
    console.log('No events found.');
    return;
  }

  console.log('\nFirst 3 events:');
  preview.forEach((event, i) => {
    const title = event.summary ?? '(no title)';
    const start = event.start?.dateTime ?? event.start?.date ?? '(no start time)';
    const id = event.id;
    console.log(`\n[${i + 1}] ${title}`);
    console.log(`    Start: ${start}`);
    console.log(`    ID:    ${id}`);
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
