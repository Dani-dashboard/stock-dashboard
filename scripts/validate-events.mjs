import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const file = path.join(root, 'data/events.json');

const allowedImpact = new Set(['High', 'Medium', 'Watch', 'Info']);
const allowedGroups = new Set(['FX', 'Rates', 'US', 'KR', 'Semis', 'Commodity', 'Commodities', 'Crypto', 'US Futures', 'KIS']);

const payload = JSON.parse(await fs.readFile(file, 'utf8'));
const errors = [];

if (!payload || typeof payload !== 'object' || Array.isArray(payload)) errors.push('root must be an object');
if (!Array.isArray(payload.todayIssues)) errors.push('todayIssues must be an array');
if (!Array.isArray(payload.weeklyEvents)) errors.push('weeklyEvents must be an array');
if (!Array.isArray(payload.structuralEvents)) errors.push('structuralEvents must be an array');

for (const [index, issue] of (payload.todayIssues || []).entries()) {
  const prefix = `todayIssues[${index}]`;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    errors.push(`${prefix} must be an object`);
    continue;
  }
  if (!issue.title || typeof issue.title !== 'string') errors.push(`${prefix}.title is required`);
  validateImpact(issue.impact, `${prefix}.impact`);
  validateGroups(issue.relatedGroups || [], `${prefix}.relatedGroups`);
  if (issue.summary !== undefined && typeof issue.summary !== 'string') errors.push(`${prefix}.summary must be a string when present`);
}

for (const [dayIndex, day] of (payload.weeklyEvents || []).entries()) {
  const prefix = `weeklyEvents[${dayIndex}]`;
  if (!day || typeof day !== 'object' || Array.isArray(day)) {
    errors.push(`${prefix} must be an object`);
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date || '')) errors.push(`${prefix}.date must be YYYY-MM-DD`);
  if (!Array.isArray(day.events)) errors.push(`${prefix}.events must be an array`);
  for (const [eventIndex, event] of (day.events || []).entries()) {
    const eventPrefix = `${prefix}.events[${eventIndex}]`;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      errors.push(`${eventPrefix} must be an object`);
      continue;
    }
    validateCalendarItem(event, eventPrefix);
  }
}

for (const [index, event] of (payload.structuralEvents || []).entries()) {
  const prefix = `structuralEvents[${index}]`;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    errors.push(`${prefix} must be an object`);
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date || '')) errors.push(`${prefix}.date must be YYYY-MM-DD`);
  validateCalendarItem(event, prefix);
}

const futureStructuralEvents = (payload.structuralEvents || [])
  .filter(event => /^\d{4}-\d{2}-\d{2}$/.test(event.date || '') && event.date >= new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }));
if (futureStructuralEvents.length < 8) {
  errors.push(`structuralEvents has only ${futureStructuralEvents.length} upcoming item(s); expected at least 8 so weekly refreshes do not accidentally wipe the annual/core schedule`);
}

function validateCalendarItem(event, prefix) {
  if (!event.title || typeof event.title !== 'string') errors.push(`${prefix}.title is required`);
  validateImpact(event.impact, `${prefix}.impact`);
  validateGroups(event.relatedGroups || [], `${prefix}.relatedGroups`);
  if (event.summary !== undefined && typeof event.summary !== 'string') errors.push(`${prefix}.summary must be a string when present`);
}

function validateImpact(value, path) {
  if (!allowedImpact.has(value)) errors.push(`${path} must be one of ${Array.from(allowedImpact).join(', ')}`);
}

function validateGroups(groups, path) {
  if (!Array.isArray(groups)) {
    errors.push(`${path} must be an array`);
    return;
  }
  for (const group of groups) {
    if (!allowedGroups.has(group)) errors.push(`${path} contains unknown group: ${group}`);
  }
}

if (errors.length) {
  console.error(`events validation failed: ${errors.length} issue(s)`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const eventCount = (payload.todayIssues || []).length
  + (payload.weeklyEvents || []).reduce((sum, day) => sum + (day.events || []).length, 0)
  + (payload.structuralEvents || []).length;
console.log(`events validation passed: ${eventCount} item(s), including ${(payload.structuralEvents || []).length} structural event(s)`);
