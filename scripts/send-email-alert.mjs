import { spawn } from 'node:child_process';

const to = process.env.ALERT_EMAIL_TO || process.argv[2];
const subject = process.env.ALERT_EMAIL_SUBJECT || process.argv.slice(3).join(' ');
const from = process.env.ALERT_EMAIL_FROM || 'stock-dashboard-alert@localhost';

if (!to || !subject) {
  console.error('usage: ALERT_EMAIL_TO=you@example.com ALERT_EMAIL_SUBJECT="subject" node scripts/send-email-alert.mjs');
  process.exit(2);
}

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
].join('\n');

await sendmail(message);
console.log(`sent email attempt to ${to}: ${subject}`);

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]/g, ' ').trim();
}

function encodeSubject(value) {
  const clean = sanitizeHeader(value);
  if (/^[\x00-\x7F]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function sendmail(message) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/sbin/sendmail', ['-t'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`sendmail exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(message);
    child.stdin.end();
  });
}
