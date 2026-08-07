import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const file = path.join(root, 'data/events.json');

const nowArg = process.argv.find((arg) => arg.startsWith('--now='));
const now = nowArg ? new Date(nowArg.slice('--now='.length)) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error('Invalid --now value. Use an ISO datetime.');
  process.exit(64);
}

const payload = JSON.parse(await fs.readFile(file, 'utf8'));
const structuralEvents = Array.isArray(payload.structuralEvents) ? payload.structuralEvents : [];
const review = payload.structuralReview && typeof payload.structuralReview === 'object' ? payload.structuralReview : {};
const cadenceDays = Number.isFinite(review.reviewCadenceDays) ? review.reviewCadenceDays : 14;
const lastReviewedAt = new Date(review.lastReviewedAt || 0);
const nextReviewDue = review.nextReviewDue ? parseKstDate(review.nextReviewDue) : addDays(lastReviewedAt, cadenceDays);
const todayYmd = formatKstYmd(now);
const horizon = addDays(parseKstDate(todayYmd), 90);

const futureEvents = structuralEvents
  .filter((event) => /^\d{4}-\d{2}-\d{2}$/.test(event.date || '') && event.date >= todayYmd)
  .sort((a, b) => a.date.localeCompare(b.date) || String(a.title || '').localeCompare(String(b.title || '')));
const horizonEvents = futureEvents.filter((event) => parseKstDate(event.date).getTime() <= horizon.getTime());

const errors = [];
if (!structuralEvents.length) errors.push('structuralEvents is empty');
if (Number.isNaN(lastReviewedAt.getTime())) errors.push('structuralReview.lastReviewedAt is missing or invalid');
if (todayYmd >= formatKstYmd(nextReviewDue)) errors.push(`structural event source review is due: nextReviewDue=${formatKstYmd(nextReviewDue)}, today=${todayYmd}`);
if (futureEvents.length < 8) errors.push(`only ${futureEvents.length} upcoming structural event(s); expected at least 8`);
if (horizonEvents.length < 6) errors.push(`only ${horizonEvents.length} structural event(s) in next 90 days; expected at least 6`);

const sourceChecks = [
  [/Bank of Korea|BOK|한국은행/i, 'BOK official schedule'],
  [/Federal Reserve|FOMC/i, 'Federal Reserve FOMC calendar'],
  [/Bank of Japan|BOJ/i, 'Bank of Japan MPM schedule'],
  [/KRX|KOSPI200|한국 .*옵션|동시만기/i, 'KRX derivatives expiry/session calendar'],
  [/OpEx|options|quarterly expiry|미국 .*옵션|분기 .*만기/i, 'US options/futures expiry calendar'],
];
for (const [pattern, label] of sourceChecks) {
  const found = futureEvents.some((event) => pattern.test(`${event.title || ''} ${event.source || ''} ${event.summary || ''}`));
  if (!found) errors.push(`no upcoming structural event found for ${label}`);
}

if (errors.length) {
  console.error('structural event freshness failed');
  console.error(`lastReviewedAt=${review.lastReviewedAt || 'missing'} cadenceDays=${cadenceDays} nextReviewDue=${formatKstYmd(nextReviewDue)} today=${todayYmd}`);
  for (const error of errors) console.error(`- ${error}`);
  console.error('Action: re-check official/credible BOK, FOMC, BOJ, KRX, US OpEx/futures-expiry, holiday/rebalance sources and update data/events.json structuralEvents + structuralReview.');
  process.exit(2);
}

console.log(`structural event freshness passed: ${futureEvents.length} upcoming event(s), ${horizonEvents.length} in next 90 days, lastReviewedAt=${review.lastReviewedAt}, nextReviewDue=${formatKstYmd(nextReviewDue)}`);

function parseKstDate(ymd) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, -9, 0, 0, 0));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function formatKstYmd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
