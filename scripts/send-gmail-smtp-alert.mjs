import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';

await loadEnvFile('.env.alerts');

const user = process.env.ALERT_EMAIL_USER;
const pass = process.env.ALERT_EMAIL_APP_PASSWORD;
const to = process.env.ALERT_EMAIL_TO || user;
const from = process.env.ALERT_EMAIL_FROM || user;
const subject = process.env.ALERT_EMAIL_SUBJECT || process.argv.slice(2).join(' ');

if (!user || !pass) {
  console.error('Missing ALERT_EMAIL_USER or ALERT_EMAIL_APP_PASSWORD. Run npm run alert:gmail:setup first.');
  process.exit(2);
}
if (!subject) {
  console.error('Missing ALERT_EMAIL_SUBJECT or subject argument.');
  process.exit(2);
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user, pass }
});

const info = await transporter.sendMail({
  from,
  to,
  subject,
  text: ''
});

console.log(`gmail smtp sent: ${info.messageId || '(no message id)'} to ${to}: ${subject}`);

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
