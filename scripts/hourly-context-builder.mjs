import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'config/market-intelligence.json'), 'utf8'));
const dbPath = path.join(root, config.storage?.path || 'data/market-intelligence.sqlite');
const outPath = path.join(root, process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length) || 'data/hourly-context.json');
const asOfArg = process.argv.find(arg => arg.startsWith('--as-of='))?.slice('--as-of='.length);
const now = asOfArg ? new Date(asOfArg) : new Date();
const timestamp = floorToHour(now).toISOString();

const [latest, events] = await Promise.all([
  readJsonIfExists(path.join(root, 'data/latest.json'), null),
  readJsonIfExists(path.join(root, 'data/events.json'), null)
]);

const db = new DatabaseSync(dbPath);
try {
  db.exec(`PRAGMA busy_timeout = ${Number(config.storage?.busyTimeoutMs || 5000)}`);
  db.exec('PRAGMA foreign_keys = ON');
  assertSchema(db);

  const stateRows = db.prepare('SELECT * FROM market_state_10m WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 6').all(now.toISOString());
  if (!stateRows.length) throw new Error('No market_state_10m rows found. Run `npm run mi:state` first.');
  const currentState = buildState(stateRows[0]);
  const previousStates = stateRows.slice(1).map(buildState);
  const features = db.prepare('SELECT * FROM market_features_10m WHERE timestamp = ? ORDER BY metric_id').all(stateRows[0].timestamp);
  const observations = db.prepare('SELECT * FROM market_observations WHERE observed_timestamp <= ? ORDER BY observed_timestamp DESC LIMIT 80').all(now.toISOString());

  const context = buildContext({ timestamp, now, latest, events, currentState, previousStates, features, observations });
  const contextHash = hashJson(context);
  persistContext(db, { timestamp, context, contextHash, sourceStateTimestamp: currentState.timestamp });
  const payload = {
    schemaVersion: config.schemaVersion,
    generatedAt: new Date().toISOString(),
    engine: {
      type: 'hourly-market-context',
      aiUsed: false,
      source: 'market_state_10m + selected latest/events data',
      dbPath: config.storage?.path || 'data/market-intelligence.sqlite'
    },
    timestamp,
    sessionPhase: context.sessionPhase,
    contextHash,
    sourceStateTimestamp: currentState.timestamp,
    context
  };
  await writeJsonAtomic(outPath, payload);
  console.log(JSON.stringify({ ok: true, out: path.relative(root, outPath), timestamp, sessionPhase: context.sessionPhase, contextHash, sourceStateTimestamp: currentState.timestamp }, null, 2));
} finally {
  db.close();
}

function assertSchema(db) {
  for (const table of ['market_state_10m', 'market_features_10m', 'market_observations', 'hourly_context']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!row) throw new Error(`${table} missing. Run \`npm run mi:migrate\` first.`);
  }
}

function buildContext({ timestamp, now, latest, events, currentState, previousStates, features, observations }) {
  const metricsById = new Map((latest?.metrics || []).map(m => [m.id, m]));
  const topFeatures = features
    .map(featureSignal)
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 12);
  const eventContext = selectEventContext(events, now);
  const quality = currentState.dataQuality || {};
  const stateHistory = [currentState, ...previousStates].map(s => ({
    timestamp: s.timestamp,
    regime: s.regime,
    riskBudget: s.riskBudget,
    scores: s.scores
  }));
  const keyMetrics = ['kospi200', 'kospi', 'kospi200_futures_kis', 'usdkrw', 'jpykrw_100', 'spx_f', 'nasdaq_f', 'sox', 'vix', 'us10y', 'dxy']
    .map(id => metricSnapshot(metricsById.get(id)))
    .filter(Boolean);
  return {
    timestamp,
    sessionPhase: sessionPhaseKst(now),
    guardrails: [
      'Do not recalculate numeric scores with AI.',
      'Treat deterministic regime and source quality as ground truth for this summary.',
      'Use cautious language when confidence is low or sources are stale.'
    ],
    marketState: currentState,
    stateHistory,
    keyMetrics,
    strongestSignals: topFeatures,
    events: eventContext,
    dataQuality: {
      confidence: currentState.scores?.confidence ?? null,
      qualityCounts: quality.qualityCounts || {},
      featureCount: quality.featureCount || features.length,
      warnings: currentState.warnings || []
    },
    recentObservationCoverage: summarizeObservations(observations),
    writingStyle: {
      language: 'ko-KR',
      tone: 'calm, concise, decision-supportive',
      targetLength: '3-5 bullets + base case + invalidation/watch triggers',
      avoid: ['overconfidence', 'trade recommendation as certainty', 'wall of text']
    }
  };
}

function buildState(row) {
  return {
    timestamp: row.timestamp,
    previousTimestamp: row.previous_timestamp || null,
    regime: row.regime,
    previousRegime: row.previous_regime || null,
    riskBudget: numberOrNull(row.risk_budget),
    scores: {
      direction: numberOrNull(row.direction_score),
      directionDelta10m: numberOrNull(row.direction_delta10m),
      flow: numberOrNull(row.flow_score),
      flowDelta10m: numberOrNull(row.flow_delta10m),
      stress: numberOrNull(row.stress_score),
      stressDelta10m: numberOrNull(row.stress_delta10m),
      breadth: numberOrNull(row.breadth_score),
      breadthDelta10m: numberOrNull(row.breadth_delta10m),
      confidence: numberOrNull(row.confidence_score)
    },
    positiveDrivers: parseJson(row.positive_drivers_json, []),
    negativeDrivers: parseJson(row.negative_drivers_json, []),
    warnings: parseJson(row.warnings_json, []),
    watchConditions: parseJson(row.watch_conditions_json, []),
    invalidationConditions: parseJson(row.invalidation_conditions_json, []),
    dataQuality: parseJson(row.data_quality_json, {}),
    stateMachine: parseJson(row.state_machine_json, {})
  };
}

function featureSignal(row) {
  const pct10 = numberOrNull(row.pct_delta10m);
  const usablePct10 = Number.isFinite(pct10) && Math.abs(pct10) <= 25 ? pct10 : null;
  const candidates = [
    Math.abs(usablePct10 ?? 0) * 20,
    Math.min(Math.abs(numberOrNull(row.delta10m) ?? 0), 100),
    Math.abs(numberOrNull(row.same_time_z) ?? 0) * 15
  ];
  const score = Math.max(...candidates.filter(Number.isFinite), 0);
  if (score <= 0 && row.quality_level !== 'warn') return null;
  return {
    metricId: row.metric_id,
    metricType: row.metric_type,
    level: numberOrNull(row.level),
    delta10m: numberOrNull(row.delta10m),
    pctDelta10m: usablePct10,
    delta30m: numberOrNull(row.delta30m),
    pctDelta30m: numberOrNull(row.pct_delta30m),
    sameTimeZ: numberOrNull(row.same_time_z),
    rollingPercentile: numberOrNull(row.rolling_percentile),
    qualityLevel: row.quality_level,
    qualityMessage: row.quality_message,
    score: round(score)
  };
}

function metricSnapshot(metric) {
  if (!metric) return null;
  return {
    id: metric.id,
    name: metric.name,
    group: metric.group,
    value: numberOrNull(metric.value),
    changePct: numberOrNull(metric.changePct),
    status: metric.status?.level || null,
    statusMessage: metric.status?.message || metric.delayNote || null,
    timestamp: metric.timestamp || null
  };
}

function selectEventContext(events, now) {
  if (!events) return { todayIssues: [], weeklyEvents: [], structuralEvents: [] };
  const kstDate = dateKeyKst(now);
  const todayIssues = Array.isArray(events.todayIssues) ? events.todayIssues : [];
  const weeklyEvents = (Array.isArray(events.weeklyEvents) ? events.weeklyEvents : [])
    .filter(e => !e.date || e.date >= kstDate)
    .slice(0, 8)
    .map(eventSnapshot);
  const structuralEvents = (Array.isArray(events.structuralEvents) ? events.structuralEvents : [])
    .filter(e => !e.date || e.date >= kstDate)
    .slice(0, 5)
    .map(eventSnapshot);
  return { todayIssues: todayIssues.slice(0, 8).map(eventSnapshot), weeklyEvents, structuralEvents, sourceNote: events.sourceNote || events.source || null };
}

function eventSnapshot(e) {
  return {
    date: e.date || null,
    timeKst: e.timeKst || e.time || null,
    title: e.title || e.name || null,
    impact: e.impact || null,
    relatedGroups: e.relatedGroups || e.groups || [],
    summary: e.summary || e.why || null,
    source: e.source || null,
    status: e.status || null
  };
}

function summarizeObservations(rows) {
  const byQuality = {};
  for (const row of rows) byQuality[row.quality_level || 'unknown'] = (byQuality[row.quality_level || 'unknown'] || 0) + 1;
  return { recentRows: rows.length, byQuality, latestObservedAt: rows[0]?.observed_timestamp || null };
}

function persistContext(db, { timestamp, context, contextHash, sourceStateTimestamp }) {
  const stmt = db.prepare(`
    INSERT INTO hourly_context(timestamp, session_phase, context_json, context_hash, source_state_timestamp, data_quality_json)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(timestamp) DO UPDATE SET
      session_phase=excluded.session_phase,
      context_json=excluded.context_json,
      context_hash=excluded.context_hash,
      source_state_timestamp=excluded.source_state_timestamp,
      data_quality_json=excluded.data_quality_json
  `);
  stmt.run(timestamp, context.sessionPhase, JSON.stringify(context), contextHash, sourceStateTimestamp, JSON.stringify(context.dataQuality || {}));
}

function sessionPhaseKst(date) {
  const minutes = minuteOfDayKst(date);
  if (minutes < 9 * 60) return 'pre_kr_open';
  if (minutes < 11 * 60) return 'kr_morning';
  if (minutes < 13 * 60) return 'kr_midday';
  if (minutes < 15 * 60 + 30) return 'kr_afternoon';
  if (minutes < 16 * 60) return 'kr_close_window';
  if (minutes < 21 * 60) return 'post_kr_pre_us';
  return 'us_evening_kst';
}

function minuteOfDayKst(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  return Number(parts.find(p => p.type === 'hour')?.value || 0) * 60 + Number(parts.find(p => p.type === 'minute')?.value || 0);
}

function dateKeyKst(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function floorToHour(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

async function readJsonIfExists(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

async function writeJsonAtomic(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.rename(tmp, file);
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}
