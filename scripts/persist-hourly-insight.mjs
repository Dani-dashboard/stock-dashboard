import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'config/market-intelligence.json'), 'utf8'));
const dbPath = path.join(root, config.storage?.path || 'data/market-intelligence.sqlite');
const inputPath = path.join(root, process.argv.find(arg => arg.startsWith('--input='))?.slice('--input='.length) || 'data/hourly-ai-insight.json');
const payload = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const insight = payload.insight;
validatePayload(payload, insight);

const db = new DatabaseSync(dbPath);
try {
  db.exec(`PRAGMA busy_timeout = ${Number(config.storage?.busyTimeoutMs || 5000)}`);
  db.exec('PRAGMA foreign_keys = ON');
  assertSchema(db);
  persistInsight(db, payload, insight);
  console.log(JSON.stringify({ ok: true, input: path.relative(root, inputPath), timestamp: payload.timestamp, status: payload.engine?.status || 'unknown', aiUsed: !!payload.engine?.aiUsed }, null, 2));
} finally {
  db.close();
}

function validatePayload(payload, insight) {
  const errors = [];
  if (!payload || typeof payload !== 'object') errors.push('payload must be object');
  if (typeof payload.timestamp !== 'string') errors.push('payload.timestamp must be string');
  if (!payload.engine || typeof payload.engine !== 'object') errors.push('payload.engine must be object');
  if (!insight || typeof insight !== 'object') errors.push('payload.insight must be object');
  for (const key of ['title', 'stance', 'sessionPhase', 'baseCase', 'dataQualityNote', 'confidenceLabel']) {
    if (typeof insight?.[key] !== 'string') errors.push(`insight.${key} must be string`);
  }
  for (const key of ['summaryBullets', 'watchTriggers', 'invalidation']) {
    if (!Array.isArray(insight?.[key]) || !insight[key].every(x => typeof x === 'string')) errors.push(`insight.${key} must be string[]`);
  }
  if (!['높음', '보통', '낮음'].includes(insight?.confidenceLabel)) errors.push('insight.confidenceLabel invalid');
  if (errors.length) throw new Error(errors.join('; '));
}

function assertSchema(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hourly_ai_insight'").get();
  if (!row) throw new Error('hourly_ai_insight table missing. Run `npm run mi:migrate` first.');
}

function persistInsight(db, payload, insight) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO hourly_ai_insight(timestamp, session_phase, model, reasoning, status, insight_json, schema_version, validation_error, context_hash, source_context_timestamp, started_at, completed_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(timestamp) DO UPDATE SET
      session_phase=excluded.session_phase,
      model=excluded.model,
      reasoning=excluded.reasoning,
      status=excluded.status,
      insight_json=excluded.insight_json,
      schema_version=excluded.schema_version,
      validation_error=excluded.validation_error,
      context_hash=excluded.context_hash,
      source_context_timestamp=excluded.source_context_timestamp,
      started_at=excluded.started_at,
      completed_at=excluded.completed_at
  `);
  stmt.run(
    payload.timestamp,
    insight.sessionPhase || payload.sessionPhase || 'unknown',
    payload.engine?.model || null,
    null,
    payload.engine?.status || 'openclaw_managed',
    JSON.stringify(insight),
    payload.schemaVersion || config.schemaVersion,
    payload.validationError || null,
    payload.contextHash || null,
    payload.sourceContextTimestamp || payload.timestamp,
    payload.startedAt || payload.generatedAt || now,
    payload.completedAt || payload.generatedAt || now
  );
}
