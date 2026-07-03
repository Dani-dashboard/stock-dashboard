import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const envPath = '.env.alerts';
const account = process.env.ALERT_EMAIL_USER || 'hummingscape@gmail.com';

await runOsascript([
  '-e', `display dialog "Gmail 앱 비밀번호를 만들 준비를 해주세요.\n\n1) 열리는 Google 페이지에서 앱 비밀번호를 생성\n2) 생성된 16자리 비밀번호를 복사\n3) 다음 입력창에 붙여넣기\n\n채팅에는 절대 붙여넣지 마세요." buttons {"Google 앱 비밀번호 페이지 열기", "취소"} default button "Google 앱 비밀번호 페이지 열기" with title "Stock Dashboard Gmail Alert Setup"`,
]);

await execFileAsync('open', ['https://myaccount.google.com/apppasswords']);

const { stdout } = await runOsascript([
  '-e', `display dialog "Google 앱 비밀번호 16자리를 붙여넣어 주세요.\n\n입력값은 숨김 처리되고 로컬 .env.alerts에 chmod 600으로 저장됩니다." default answer "" with hidden answer buttons {"저장", "취소"} default button "저장" with title "Gmail 앱 비밀번호 입력"`,
]);

const match = stdout.match(/text returned:(.*?)(?:, button returned:|$)/s);
const appPassword = (match?.[1] || '').trim().replace(/\s+/g, '');
if (!appPassword || appPassword.length < 12) {
  console.error('No valid app password captured. Aborting.');
  process.exit(1);
}

const content = [
  `ALERT_EMAIL_PROVIDER=gmail-smtp`,
  `ALERT_EMAIL_USER=${account}`,
  `ALERT_EMAIL_TO=${account}`,
  `ALERT_EMAIL_FROM=${account}`,
  `ALERT_EMAIL_APP_PASSWORD=${appPassword}`,
  ''
].join('\n');

await fs.writeFile(envPath, content, { mode: 0o600 });
await fs.chmod(envPath, 0o600);
console.log(`${envPath} saved for ${account} with chmod 600`);

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
