import fs from 'node:fs/promises';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { google } from 'googleapis';

const execFileAsync = promisify(execFile);
const envPath = '.env.alerts';
const port = Number(process.env.GMAIL_OAUTH_PORT || 8789);
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const account = process.env.ALERT_EMAIL_USER || 'hummingscape@gmail.com';

await runOsascript([
  '-e', `display dialog "Gmail API OAuth 설정을 시작합니다.\n\n필요한 것:\n1) Google Cloud에서 Gmail API 활성화\n2) OAuth Client ID 유형: Desktop app\n3) Client ID와 Client Secret\n\n다음 창에 Client ID/Secret을 붙여넣습니다." buttons {"Google Cloud Console 열기", "이미 준비됨", "취소"} default button "이미 준비됨" with title "Gmail API OAuth Setup"`
]).then(async ({ stdout }) => {
  if (stdout.includes('Google Cloud Console 열기')) {
    await execFileAsync('open', ['https://console.cloud.google.com/apis/library/gmail.googleapis.com']);
    await execFileAsync('open', ['https://console.cloud.google.com/apis/credentials']);
  }
});

const clientId = (await promptHiddenOrText('Google OAuth Client ID를 입력해 주세요.', false)).trim();
const clientSecret = (await promptHiddenOrText('Google OAuth Client Secret을 입력해 주세요.', true)).trim();
if (!clientId || !clientSecret) {
  console.error('Missing client id/secret. Aborting.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/gmail.send'],
  login_hint: account
});

const codePromise = waitForCode(port);
await execFileAsync('open', [authUrl]);
console.log(`Opened Gmail OAuth URL. Waiting for callback on ${redirectUri}`);
const code = await codePromise;
const { tokens } = await oauth2Client.getToken(code);
if (!tokens.refresh_token) {
  console.error('No refresh_token returned. Re-run setup and ensure prompt=consent / first-time consent.');
  process.exit(1);
}

const content = [
  `ALERT_EMAIL_PROVIDER=gmail-api`,
  `ALERT_EMAIL_USER=${account}`,
  `ALERT_EMAIL_TO=${account}`,
  `ALERT_EMAIL_FROM=${account}`,
  `GMAIL_CLIENT_ID=${clientId}`,
  `GMAIL_CLIENT_SECRET=${clientSecret}`,
  `GMAIL_REDIRECT_URI=${redirectUri}`,
  `GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`,
  ''
].join('\n');

await fs.writeFile(envPath, content, { mode: 0o600 });
await fs.chmod(envPath, 0o600);
console.log(`${envPath} saved for Gmail API send as ${account} with chmod 600`);

async function promptHiddenOrText(message, hidden) {
  const hiddenPart = hidden ? ' with hidden answer' : '';
  const { stdout } = await runOsascript([
    '-e', `display dialog "${escapeAppleScript(message)}\n\n채팅에는 붙여넣지 마세요." default answer ""${hiddenPart} buttons {"저장", "취소"} default button "저장" with title "Gmail API OAuth Setup"`
  ]);
  const match = stdout.match(/text returned:(.*?)(?:, button returned:|$)/s);
  return match?.[1] || '';
}

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

async function runOsascript(args) {
  try {
    return await execFileAsync('osascript', args, { timeout: 0 });
  } catch (err) {
    if (err.code === 1 || /User canceled/.test(err.stderr || '')) {
      console.error('User canceled.');
      process.exit(1);
    }
    throw err;
  }
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
