const { google } = require('googleapis');
const readline = require('readline');
require('dotenv').config();

/**
 * This script helps you generate a GOOGLE_REFRESH_TOKEN for your .env file.
 */

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost' // Redirect URI (doesn't need to be a real working URL for manual copy-paste)
);

const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks'
];

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Forces it to return a refresh token
});

console.log('\n--- Google OAuth2 Setup ---\n');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Authorize the application.');
console.log('3. After authorizing, you will be redirected to localhost (it might show an error page, that is fine).');
console.log('4. Copy the "code" parameter from the URL in your browser address bar.');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.question('\n5. Paste the code here: ', async (code) => {
    rl.close();
    try {
        const { tokens } = await oauth2Client.getToken(decodeURIComponent(code));
        console.log('\n--- SUCCESS! ---\n');
        console.log('Copy this Refresh Token and add it to your .env file:');
        console.log('\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
        console.log('\n----------------\n');
    } catch (err) {
        console.error('\nError retrieving tokens:', err.message);
    }
});
