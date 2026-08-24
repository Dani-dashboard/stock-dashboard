import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'config/market-intelligence.json'), 'utf8'));
const dbPath = path.join(root, config.storage?.path || 'data/market-intelligence.sqlite');
const outPath = path.join(root, process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length) || 'data/market-state-10m.json');

const db = new DatabaseSync(dbPath);
try {
  db.exec(`PRAGMA busy_timeout = ${Number(config.storage?.busyTimeoutMs || 5000)}`);
  const row = db.prepare('SELECT * FROM market_state_10m ORDER BY timestamp DESC LIMIT 1').get();
  if (!row) throw new Error('No market_state_10m rows found. Run `npm run mi:state` first.');
  const payload = buildPayload(row);
  await writeJsonAtomic(outPath, payload);
  console.log(JSON.stringify({ ok: true, out: path.relative(root, outPath), timestamp: payload.timestamp, regime: payload.regime }, null, 2));
} finally {
  db.close();
}

function buildPayload(row) {
  return {
    schemaVersion: config.schemaVersion,
    generatedAt: new Date().toISOString(),
    engine: {
      type: 'deterministic-cpu-sidecar',
      interval: '10m',
      aiUsed: false,
      dbPath: config.storage?.path || 'data/market-intelligence.sqlite'
    },
    timestamp: row.timestamp,
    previousTimestamp: row.previous_timestamp,
    regime: row.regime,
    previousRegime: row.previous_regime,
    riskBudget: row.risk_budget,
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
    contributionBreakdown: parseJson(row.contribution_breakdown_json, {}),
    dataQuality: parseJson(row.data_quality_json, {}),
    stateMachine: parseJson(row.state_machine_json, {})
  };
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

async function writeJsonAtomic(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.rename(tmp, file);
}
