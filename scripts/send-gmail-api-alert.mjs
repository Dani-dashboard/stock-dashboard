import fs from 'node:fs/promises';
import { google } from 'googleapis';

await loadEnvFile('.env.alerts');

const user = process.env.ALERT_EMAIL_USER || 'me';
const to = process.env.ALERT_EMAIL_TO || process.env.ALERT_EMAIL_USER;
const from = process.env.ALERT_EMAIL_FROM || process.env.ALERT_EMAIL_USER;
const subject = process.env.ALERT_EMAIL_SUBJECT || process.argv.slice(2).join(' ');

if (!subject) {
  console.error('Missing ALERT_EMAIL_SUBJECT or subject argument.');
  process.exit(2);
}

const auth = gmailAuth();
const gmail = google.gmail({ version: 'v1', auth });
const raw = buildRawMessage({ to, from, subject });
const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
console.log(`gmail api sent: ${res.data.id || '(no id)'} to ${to}: ${subject}`);

export function gmailAuth() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://127.0.0.1:8789/oauth2callback';
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Missing Gmail API credentials. Run npm run alert:gmail-api:setup first.');
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

export function buildRawMessage({ to, from, subject }) {
  const message = [
    `To: ${sanitizeHeader(to)}`,
    `From: ${sanitizeHeader(from)}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
    ''
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim();
}

function encodeSubject(value) {
  const clean = sanitizeHeader(value);
  if (/^[\x00-\x7F]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

async function loadEnvFile(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
