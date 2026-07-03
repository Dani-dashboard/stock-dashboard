import fs from 'node:fs/promises';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { google } from 'googleapis';

const execFileAsync = promisify(execFile);
const envPath = '.env.alerts';
await loadEnvFile(envPath);

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://127.0.0.1:8789/oauth2callback';
const account = process.env.ALERT_EMAIL_USER || 'hummingscape@gmail.com';
if (!clientId || !clientSecret) {
  console.error('Missing GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET in .env.alerts');
  process.exit(2);
}

const port = Number(new URL(redirectUri).port || 8789);
const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/gmail.send'],
  login_hint: account
});

const codePromise = waitForCode(port);
await execFileAsync('open', [authUrl]);
console.log(`Opened OAuth consent URL. Waiting for callback on ${redirectUri}`);
const code = await codePromise;
const { tokens } = await oauth2Client.getToken(code);
if (!tokens.refresh_token) {
  console.error('No refresh_token returned. Revoke app access and retry, or ensure prompt=consent.');
  process.exit(1);
}

await upsertEnv(envPath, {
  GMAIL_REFRESH_TOKEN: tokens.refresh_token,
  ALERT_EMAIL_PROVIDER: 'gmail-api'
});
await fs.chmod(envPath, 0o600);
console.log('Gmail API refresh token saved to .env.alerts with chmod 600');

function waitForCode(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end('Not found');
          return;
        }
        const error = url.searchParams.get('error');
        if (error) throw new Error(`OAuth error: ${error}`);
        const code = url.searchParams.get('code');
        if (!code) throw new Error('Missing code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h2>Gmail API authorization complete.</h2><p>You can close this tab and return to OpenClaw.</p>');
        server.close();
        resolve(code);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(err.message);
        server.close();
        reject(err);
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for OAuth callback'));
    }, 10 * 60 * 1000).unref();
  });
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

async function upsertEnv(file, values) {
  let lines = [];
  try { lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/); } catch {}
  const seen = new Set();
  lines = lines.map(line => {
    const index = line.indexOf('=');
    if (index === -1) return line;
    const key = line.slice(0, index).trim();
    if (Object.hasOwn(values, key)) {
      seen.add(key);
      return `${key}=${values[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  await fs.writeFile(file, lines.filter((line, i, arr) => line || i < arr.length - 1).join('\n') + '\n');
}
