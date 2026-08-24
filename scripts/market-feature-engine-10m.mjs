import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'config/market-intelligence.json'), 'utf8'));
const dbPath = path.join(root, config.storage?.path || 'data/market-intelligence.sqlite');
const asOfArg = process.argv.find(arg => arg.startsWith('--as-of='))?.slice('--as-of='.length);
const now = asOfArg ? new Date(asOfArg) : new Date();
const asOf = floorToInterval(now, Number(config.engine?.featureIntervalMinutes || 10)).toISOString();
const currentCutoff = now.toISOString();

const db = new DatabaseSync(dbPath);
try {
  db.exec(`PRAGMA busy_timeout = ${Number(config.storage?.busyTimeoutMs || 5000)}`);
  db.exec('PRAGMA foreign_keys = ON');
  assertSchema(db);

  const current = latestObservationsAtOrBefore(db, currentCutoff);
  const features = current.map(row => buildFeature(db, row, asOf));
  const written = persistFeatures(db, features);
  console.log(JSON.stringify({ ok: true, asOf, currentCutoff, currentObservations: current.length, features: features.length, written }, null, 2));
} finally {
  db.close();
}

function assertSchema(db) {
  for (const table of ['market_observations', 'market_features_10m']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!row) throw new Error(`${table} missing. Run \`npm run mi:migrate\` first.`);
  }
}

function latestObservationsAtOrBefore(db, asOf) {
  return db.prepare(`
    SELECT o.*
    FROM market_observations o
    JOIN (
      SELECT metric_id, MAX(observed_timestamp) AS observed_timestamp
      FROM market_observations
      WHERE observed_timestamp <= ?
      GROUP BY metric_id
    ) latest
      ON latest.metric_id = o.metric_id
     AND latest.observed_timestamp = o.observed_timestamp
    ORDER BY o.metric_id
  `).all(asOf);
}

function buildFeature(db, row, asOf) {
  const level = numberOrNull(row.value);
  const currentObservedAt = row.observed_timestamp || asOf;
  const w10 = windowDelta(db, row.metric_id, level, currentObservedAt, 10, row.source_timestamp);
  const w30 = windowDelta(db, row.metric_id, level, currentObservedAt, 30, row.source_timestamp);
  const w60 = windowDelta(db, row.metric_id, level, currentObservedAt, 60, row.source_timestamp);
  const prev10Feature = db.prepare('SELECT delta10m FROM market_features_10m WHERE metric_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(row.metric_id, asOf);
  const acceleration = numberOrNull(w10.delta) !== null && numberOrNull(prev10Feature?.delta10m) !== null
    ? round(w10.delta - prev10Feature.delta10m)
    : null;
  const norm = normalization(db, row.metric_id, level, currentObservedAt);
  const quality = featureQuality(row, [w10, w30, w60], norm);
  return {
    timestamp: asOf,
    metricId: row.metric_id,
    metricType: row.metric_type,
    level,
    delta10m: w10.delta,
    delta30m: w30.delta,
    delta60m: w60.delta,
    pctDelta10m: w10.pctDelta,
    pctDelta30m: w30.pctDelta,
    pctDelta60m: w60.pctDelta,
    slope30m: w30.delta === null ? null : round(w30.delta / 30),
    slope60m: w60.delta === null ? null : round(w60.delta / 60),
    acceleration,
    sameTimeZ: norm.sameTimeZ,
    rollingPercentile: norm.rollingPercentile,
    sampleCount: norm.sampleCount,
    sameTimeSampleCount: norm.sameTimeSampleCount,
    qualityLevel: quality.level,
    qualityMessage: quality.message,
    sourceObservationId: row.id,
    raw: { sourceObservationId: row.id, windows: { w10, w30, w60 }, normalization: norm, sourceQuality: row.quality_level }
  };
}

function windowDelta(db, metricId, currentLevel, asOf, minutes, sourceTimestamp = null) {
  if (!Number.isFinite(currentLevel)) return { minutes, delta: null, pctDelta: null, referenceTimestamp: null, referenceValue: null, reason: 'current level missing' };
  const targetMs = new Date(asOf).getTime() - minutes * 60_000;
  const toleranceMs = Math.min(5 * 60_000, Math.max(90_000, minutes * 60_000 * 0.25));
  const from = new Date(targetMs - toleranceMs).toISOString();
  const to = new Date(targetMs + toleranceMs).toISOString();
  const targetIso = new Date(targetMs).toISOString();
  const ref = db.prepare(`
    SELECT observed_timestamp, value
    FROM market_observations
    WHERE metric_id = ?
      AND observed_timestamp BETWEEN ? AND ?
      AND value IS NOT NULL
    ORDER BY ABS(strftime('%s', observed_timestamp) - strftime('%s', ?)) ASC
    LIMIT 1
  `).get(metricId, from, to, targetIso);
  const previous = numberOrNull(ref?.value);
  if (!Number.isFinite(previous)) {
    const sourceAgeMs = sourceTimestamp ? new Date(asOf).getTime() - new Date(sourceTimestamp).getTime() : null;
    if (Number.isFinite(sourceAgeMs) && sourceAgeMs >= minutes * 60_000) {
      return {
        minutes,
        delta: 0,
        pctDelta: 0,
        referenceTimestamp: sourceTimestamp,
        referenceValue: currentLevel,
        reason: 'flat reference quote: source timestamp predates window'
      };
    }
    return { minutes, delta: null, pctDelta: null, referenceTimestamp: null, referenceValue: null, reason: 'reference observation missing' };
  }
  const delta = round(currentLevel - previous);
  return {
    minutes,
    delta,
    pctDelta: previous === 0 ? null : round((delta / Math.abs(previous)) * 100),
    referenceTimestamp: ref.observed_timestamp,
    referenceValue: previous,
    reason: null
  };
}

function normalization(db, metricId, currentLevel, asOf) {
  if (!Number.isFinite(currentLevel)) return emptyNorm('current level missing');
  const lookbackDays = Number(config.engine?.normalizationTradingDays || 60) * 1.6;
  const cutoff = new Date(new Date(asOf).getTime() - lookbackDays * 86400_000).toISOString();
  const rows = db.prepare(`
    SELECT observed_timestamp, value
    FROM market_observations
    WHERE metric_id = ?
      AND observed_timestamp >= ?
      AND observed_timestamp <= ?
      AND value IS NOT NULL
    ORDER BY observed_timestamp
  `).all(metricId, cutoff, asOf).filter(r => Number.isFinite(numberOrNull(r.value)));
  const sampleCount = rows.length;
  const rolling = percentile(currentLevel, rows.map(r => numberOrNull(r.value)), Number(config.engine?.normalizationMinSamples || 20));

  const sameTimeRows = filterSameTime(rows, asOf, Number(config.engine?.sameTimeBucketMinutes || 10));
  const sameTime = zScore(currentLevel, sameTimeRows.map(r => numberOrNull(r.value)), Number(config.engine?.sameTimeMinSamples || 10));
  return {
    sampleCount,
    sameTimeSampleCount: sameTimeRows.length,
    rollingPercentile: rolling.value,
    sameTimeZ: sameTime.value,
    reason: rolling.reason || sameTime.reason || null
  };
}

function filterSameTime(rows, asOf, bucketMinutes) {
  const target = minuteOfDayKst(new Date(asOf));
  return rows.filter(row => {
    const m = minuteOfDayKst(new Date(row.observed_timestamp));
    const diff = Math.abs(m - target);
    return Math.min(diff, 1440 - diff) <= bucketMinutes;
  });
}

function percentile(current, values, minSamples) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < minSamples) return { value: null, reason: `sample_count_${clean.length}_below_${minSamples}` };
  const belowOrEqual = clean.filter(v => v <= current).length;
  return { value: round((belowOrEqual / clean.length) * 100), reason: null };
}

function zScore(current, values, minSamples) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < minSamples) return { value: null, reason: `same_time_sample_count_${clean.length}_below_${minSamples}` };
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length;
  const sd = Math.sqrt(variance);
  return { value: sd === 0 ? 0 : round((current - mean) / sd), reason: null };
}

function featureQuality(row, windows, norm) {
  if (row.quality_level === 'error') return { level: 'error', message: row.quality_message || 'source observation error' };
  if (row.quality_level === 'warn') return { level: 'warn', message: row.quality_message || 'source observation warning' };
  const availableWindows = windows.filter(w => w.delta !== null).length;
  const hasNorm = norm.rollingPercentile !== null || norm.sameTimeZ !== null;
  if (!availableWindows && !hasNorm) return { level: 'limited', message: 'history not sufficient for delta/normalization yet' };
  return { level: 'ok', message: null };
}

function persistFeatures(db, features) {
  const stmt = db.prepare(`
    INSERT INTO market_features_10m(
      timestamp, metric_id, metric_type, level,
      delta10m, delta30m, delta60m,
      pct_delta10m, pct_delta30m, pct_delta60m,
      slope30m, slope60m, acceleration,
      same_time_z, rolling_percentile, sample_count, same_time_sample_count,
      quality_level, quality_message, source_observation_id, raw_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(timestamp, metric_id) DO UPDATE SET
      metric_type=excluded.metric_type,
      level=excluded.level,
      delta10m=excluded.delta10m,
      delta30m=excluded.delta30m,
      delta60m=excluded.delta60m,
      pct_delta10m=excluded.pct_delta10m,
      pct_delta30m=excluded.pct_delta30m,
      pct_delta60m=excluded.pct_delta60m,
      slope30m=excluded.slope30m,
      slope60m=excluded.slope60m,
      acceleration=excluded.acceleration,
      same_time_z=excluded.same_time_z,
      rolling_percentile=excluded.rolling_percentile,
      sample_count=excluded.sample_count,
      same_time_sample_count=excluded.same_time_sample_count,
      quality_level=excluded.quality_level,
      quality_message=excluded.quality_message,
      source_observation_id=excluded.source_observation_id,
      raw_json=excluded.raw_json
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const f of features) {
      stmt.run(
        f.timestamp, f.metricId, f.metricType || null, f.level,
        f.delta10m, f.delta30m, f.delta60m,
        f.pctDelta10m, f.pctDelta30m, f.pctDelta60m,
        f.slope30m, f.slope60m, f.acceleration,
        f.sameTimeZ, f.rollingPercentile, f.sampleCount, f.sameTimeSampleCount,
        f.qualityLevel, f.qualityMessage, f.sourceObservationId, JSON.stringify(f.raw || {})
      );
    }
    db.exec('COMMIT');
    return features.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function emptyNorm(reason) {
  return { sampleCount: 0, sameTimeSampleCount: 0, rollingPercentile: null, sameTimeZ: null, reason };
}

function floorToInterval(date, minutes) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / minutes) * minutes);
  return d;
}

function minuteOfDayKst(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}
