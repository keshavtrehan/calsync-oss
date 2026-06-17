require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');

const REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'WEBHOOK_URL',
];

const REQUIRED_TABLES = {
  google_accounts: [
    'id',
    'label',
    'email',
    'access_token',
    'refresh_token',
    'token_expiry',
    'created_at',
  ],
  calendars: [
    'id',
    'google_account_id',
    'calendar_id',
    'label',
    'webhook_channel_id',
    'webhook_expiry',
    'created_at',
    'sync_token',
  ],
  sync_rules: [
    'id',
    'label',
    'source_calendar_id',
    'target_calendar_id',
    'is_active',
    'title_prefix',
    'title_suffix',
    'override_color',
    'copy_description',
    'copy_location',
    'copy_conference_link',
    'copy_attendees',
    'created_at',
    'updated_at',
    'copy_title',
    'target_visibility',
  ],
  event_sync_index: [
    'id',
    'sync_rule_id',
    'source_event_id',
    'target_event_id',
    'last_synced_at',
  ],
  sync_logs: [
    'id',
    'sync_rule_id',
    'action',
    'source_event_id',
    'target_event_id',
    'message',
    'error_detail',
    'created_at',
  ],
  processing_locks: [
    'id',
    'calendar_id',
    'locked_at',
  ],
};

function validateEnv() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    return [`Missing environment variables: ${missing.join(', ')}`];
  }

  try {
    const redirect = new URL(process.env.GOOGLE_REDIRECT_URI);
    if (!redirect.pathname || redirect.pathname === '/') {
      return ['GOOGLE_REDIRECT_URI must include a callback path, for example http://localhost:3000/auth/callback'];
    }
  } catch {
    return ['GOOGLE_REDIRECT_URI must be a valid URL'];
  }

  try {
    new URL(process.env.WEBHOOK_URL);
  } catch {
    return ['WEBHOOK_URL must be a valid URL'];
  }

  return [];
}

async function validateSupabaseSchema() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const errors = [];

  for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
    const { error } = await supabase
      .from(table)
      .select(columns.join(','))
      .limit(0);

    if (error) {
      errors.push(`${table}: ${error.message}`);
    }
  }

  return errors;
}

async function main() {
  const envErrors = validateEnv();
  if (envErrors.length) {
    console.error('Setup validation failed:');
    envErrors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }

  const schemaErrors = await validateSupabaseSchema();
  if (schemaErrors.length) {
    console.error('Supabase schema validation failed:');
    schemaErrors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }

  console.log('Setup validation passed.');
}

main().catch((err) => {
  console.error('Setup validation failed:', err.message);
  process.exit(1);
});
