require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const express = require('express');

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

function parseArgs(argv) {
  const args = {
    label: null,
    email: null,
    printTokens: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--print-tokens') {
      args.printTokens = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    if (arg === '--label') {
      args.label = argv[++i];
      continue;
    }

    if (arg === '--email') {
      args.email = argv[++i];
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printUsage() {
  console.log('Usage: node scripts/authenticate.js --label "<account label>" --email "<google-account-email>" [--print-tokens]');
}

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is not set`);
}

function getRedirectConfig() {
  requireEnv('GOOGLE_REDIRECT_URI', GOOGLE_REDIRECT_URI);

  const url = new URL(GOOGLE_REDIRECT_URI);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

  if (!url.pathname || url.pathname === '/') {
    throw new Error('GOOGLE_REDIRECT_URI must include a callback path, for example http://localhost:3000/auth/callback');
  }

  return {
    displayUrl: url.toString(),
    path: url.pathname,
    port,
  };
}

async function saveTokens({ supabase, label, email, tokens }) {
  if (!tokens.access_token) {
    throw new Error('Google did not return an access token.');
  }

  const tokenExpiry = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;

  const { data: existingRows, error: lookupError } = await supabase
    .from('google_accounts')
    .select('*')
    .eq('email', email)
    .limit(1);

  if (lookupError) throw new Error(`Failed to look up google_accounts row: ${lookupError.message}`);

  const existingAccount = existingRows?.[0] ?? null;
  const refreshToken = tokens.refresh_token ?? existingAccount?.refresh_token ?? null;

  if (!refreshToken) {
    throw new Error('Google did not return a refresh token. Re-run with consent forced, or remove the app grant from your Google account and try again.');
  }

  const values = {
    label,
    email,
    access_token: tokens.access_token,
    refresh_token: refreshToken,
    token_expiry: tokenExpiry,
  };

  if (existingAccount) {
    const { error } = await supabase
      .from('google_accounts')
      .update(values)
      .eq('id', existingAccount.id);

    if (error) throw new Error(`Failed to update google_accounts row: ${error.message}`);
    return { action: 'updated', id: existingAccount.id };
  }

  const { data: insertedRows, error } = await supabase
    .from('google_accounts')
    .insert(values)
    .select('id')
    .limit(1);

  if (error) throw new Error(`Failed to insert google_accounts row: ${error.message}`);
  return { action: 'inserted', id: insertedRows?.[0]?.id ?? null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (!args.label || !args.email) {
    printUsage();
    throw new Error('Missing required --label or --email argument.');
  }

  requireEnv('GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID);
  requireEnv('GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET);
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);

  const redirect = getRedirectConfig();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent',
    login_hint: args.email,
  });

  const app = express();
  let server;

  app.get(redirect.path, async (req, res) => {
    const code = req.query.code;

    if (!code) {
      res.status(400).send('Error: no authorization code received.');
      server.close();
      process.exit(1);
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);
      const result = await saveTokens({
        supabase,
        label: args.label,
        email: args.email,
        tokens,
      });

      res.send('Authentication successful. Tokens were saved to Supabase. You can close this tab.');

      console.log(`\nGoogle account ${result.action} in Supabase.`);
      console.log(`  Label: ${args.label}`);
      console.log(`  Email: ${args.email}`);
      if (result.id) console.log(`  Row ID: ${result.id}`);
      console.log('  Tokens: saved to google_accounts (not printed)');

      if (args.printTokens) {
        console.log('\n--- Tokens (--print-tokens enabled) ---');
        console.log('access_token: ', tokens.access_token);
        console.log('refresh_token:', tokens.refresh_token ?? '(preserved existing refresh token)');
        console.log('token_expiry: ', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '(none)');
        console.log('--------------------------------------\n');
      }
    } catch (err) {
      res.status(500).send('Error saving authentication tokens. Check the console.');
      console.error('Authentication failed:', err.message);
    } finally {
      server.close();
      process.exit(0);
    }
  });

  console.log('\nOpen this URL in your browser to authenticate:\n');
  console.log(authUrl);
  console.log(`\nWaiting for callback on ${redirect.displayUrl} ...\n`);

  server = app.listen(redirect.port);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
