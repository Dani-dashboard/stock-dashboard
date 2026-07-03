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
const generatedAt = new Date(payload.generatedAt || 0);
const weeklyEvents = Array.isArray(payload.weeklyEvents) ? payload.weeklyEvents : [];

const kstNow = toKstParts(now);
const targetMonday = getTargetMonday(kstNow);
const targetFriday = addDays(targetMonday, 4);
const refreshGate = addDays(targetMonday, -1); // Sunday before target week
refreshGate.hour = 20;
refreshGate.minute = 0;
refreshGate.second = 0;
refreshGate.ms = 0;

const dates = weeklyEvents.map((day) => day.date).filter(Boolean).sort();
const requiredDates = Array.from({ length: 5 }, (_, i) => formatYmd(addDays(targetMonday, i)));
const missingDates = requiredDates.filter((date) => !dates.includes(date));
const staleGeneratedAt = generatedAt.getTime() < fromKstParts(refreshGate).getTime();

const errors = [];
if (!weeklyEvents.length) errors.push('weeklyEvents is empty');
if (missingDates.length) errors.push(`weeklyEvents missing target trading dates: ${missingDates.join(', ')}`);
if (Number.isNaN(generatedAt.getTime())) errors.push('generatedAt is missing or invalid');
else if (staleGeneratedAt) errors.push(`generatedAt ${payload.generatedAt} is older than refresh gate ${formatKst(refreshGate)} KST`);

if (errors.length) {
  console.error('weekly calendar freshness failed');
  console.error(`targetWeek=${formatYmd(targetMonday)}..${formatYmd(targetFriday)} refreshGate=${formatKst(refreshGate)} KST`);
  for (const error of errors) console.error(`- ${error}`);
  console.error('Action: refresh data/events.json from https://www.youtube.com/@futuresnow/posts or ask Dani for the latest Osun weekly post text/image.');
  process.exit(2);
}

const itemCount = weeklyEvents.reduce((sum, day) => sum + (Array.isArray(day.events) ? day.events.length : 0), 0);
console.log(`weekly calendar freshness passed: ${formatYmd(targetMonday)}..${formatYmd(targetFriday)}, ${itemCount} item(s), generatedAt=${payload.generatedAt}`);

function toKstParts(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0 Sun, 1 Mon ... in KST
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
  };
}

function fromKstParts(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, parts.ms || 0) - 9 * 60 * 60 * 1000);
}

function getTargetMonday(kst) {
  const today = { ...kst, hour: 0, minute: 0, second: 0, ms: 0 };
  const daysSinceMonday = (kst.weekday + 6) % 7;
  let monday = addDays(today, -daysSinceMonday);
  if (kst.weekday === 0 && (kst.hour > 20 || (kst.hour === 20 && (kst.minute > 0 || kst.second > 0 || kst.ms > 0)))) {
    monday = addDays(today, 1);
  }
  return monday;
}

function addDays(parts, days) {
  return toKstParts(new Date(fromKstParts(parts).getTime() + days * 24 * 60 * 60 * 1000));
}

function formatYmd(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function formatKst(parts) {
  return `${formatYmd(parts)} ${String(parts.hour || 0).padStart(2, '0')}:${String(parts.minute || 0).padStart(2, '0')}`;
}
