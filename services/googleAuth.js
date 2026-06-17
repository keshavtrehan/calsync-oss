require('dotenv').config({ quiet: true });

const { google } = require('googleapis');

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

async function getAuthenticatedClient(account) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: new Date(account.token_expiry).getTime(),
  });

  const isExpiringSoon = Date.now() >= new Date(account.token_expiry).getTime() - EXPIRY_BUFFER_MS;

  if (isExpiringSoon) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);

    return {
      client: oauth2Client,
      updatedCredentials: {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token ?? account.refresh_token,
        token_expiry: new Date(credentials.expiry_date).toISOString(),
      },
    };
  }

  return {
    client: oauth2Client,
    updatedCredentials: null, // null means no refresh happened, nothing to persist
  };
}

module.exports = { getAuthenticatedClient };
