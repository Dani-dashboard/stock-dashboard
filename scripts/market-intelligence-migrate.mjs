import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config/market-intelligence.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const dbPath = path.join(root, config.storage?.path || 'data/market-intelligence.sqlite');

await fs.mkdir(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);

try {
  db.exec(`PRAGMA journal_mode = ${config.storage?.journalMode || 'WAL'}`);
  db.exec(`PRAGMA busy_timeout = ${Number(config.storage?.busyTimeoutMs || 5000)}`);
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    );
  `);

  applyMigration('001_market_intelligence_core', 'Create Market Intelligence core sidecar tables', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS market_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_id TEXT NOT NULL,
        metric_name TEXT,
        metric_type TEXT,
        source TEXT,
        provider TEXT,
        unit TEXT,
        value REAL,
        change_value REAL,
        change_pct REAL,
        source_timestamp TEXT,
        observed_timestamp TEXT NOT NULL,
        fetch_timestamp TEXT,
        latest_generated_at TEXT,
        market_session TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        stale_seconds INTEGER,
        quality_level TEXT,
        quality_message TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(metric_id, observed_timestamp, source, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_market_observations_metric_time
        ON market_observations(metric_id, observed_timestamp);
      CREATE INDEX IF NOT EXISTS idx_market_observations_time
        ON market_observations(observed_timestamp);
      CREATE INDEX IF NOT EXISTS idx_market_observations_quality
        ON market_observations(quality_level, stale);

      CREATE TABLE IF NOT EXISTS market_features_10m (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        metric_id TEXT NOT NULL,
        metric_type TEXT,
        level REAL,
        delta10m REAL,
        delta30m REAL,
        delta60m REAL,
        pct_delta10m REAL,
        pct_delta30m REAL,
        pct_delta60m REAL,
        slope30m REAL,
        slope60m REAL,
        acceleration REAL,
        same_time_z REAL,
        rolling_percentile REAL,
        sample_count INTEGER,
        same_time_sample_count INTEGER,
        quality_level TEXT,
        quality_message TEXT,
        source_observation_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        raw_json TEXT,
        UNIQUE(timestamp, metric_id),
        FOREIGN KEY(source_observation_id) REFERENCES market_observations(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_market_features_10m_time
        ON market_features_10m(timestamp);
      CREATE INDEX IF NOT EXISTS idx_market_features_10m_metric_time
        ON market_features_10m(metric_id, timestamp);

      CREATE TABLE IF NOT EXISTS market_state_10m (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL UNIQUE,
        previous_timestamp TEXT,
        regime TEXT NOT NULL,
        previous_regime TEXT,
        risk_budget INTEGER,
        direction_score REAL,
        direction_delta10m REAL,
        flow_score REAL,
        flow_delta10m REAL,
        stress_score REAL,
        stress_delta10m REAL,
        breadth_score REAL,
        breadth_delta10m REAL,
        confidence_score REAL,
        positive_drivers_json TEXT,
        negative_drivers_json TEXT,
        warnings_json TEXT,
        watch_conditions_json TEXT,
        invalidation_conditions_json TEXT,
        contribution_breakdown_json TEXT,
        data_quality_json TEXT,
        state_machine_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_market_state_10m_timestamp
        ON market_state_10m(timestamp);
      CREATE INDEX IF NOT EXISTS idx_market_state_10m_regime
        ON market_state_10m(regime, timestamp);

      CREATE TABLE IF NOT EXISTS hourly_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL UNIQUE,
        session_phase TEXT NOT NULL,
        context_json TEXT NOT NULL,
        context_hash TEXT,
        source_state_timestamp TEXT,
        data_quality_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY(source_state_timestamp) REFERENCES market_state_10m(timestamp) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hourly_context_timestamp
        ON hourly_context(timestamp);

      CREATE TABLE IF NOT EXISTS hourly_ai_insight (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL UNIQUE,
        session_phase TEXT NOT NULL,
        model TEXT,
        reasoning TEXT,
        status TEXT NOT NULL,
        insight_json TEXT,
        schema_version INTEGER,
        validation_error TEXT,
        context_hash TEXT,
        source_context_timestamp TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY(source_context_timestamp) REFERENCES hourly_context(timestamp) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hourly_ai_insight_timestamp
        ON hourly_ai_insight(timestamp);
      CREATE INDEX IF NOT EXISTS idx_hourly_ai_insight_status
        ON hourly_ai_insight(status, timestamp);

      CREATE TABLE IF NOT EXISTS hourly_forecast_evaluation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL UNIQUE,
        evaluated_insight_timestamp TEXT,
        evaluation_json TEXT NOT NULL,
        base_case_status TEXT,
        actual_regime_transition TEXT,
        triggers_hit INTEGER,
        triggers_total INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY(evaluated_insight_timestamp) REFERENCES hourly_ai_insight(timestamp) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hourly_forecast_evaluation_timestamp
        ON hourly_forecast_evaluation(timestamp);
    `);
  });

  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('market_observations','market_features_10m','market_state_10m','hourly_context','hourly_ai_insight','hourly_forecast_evaluation')
    ORDER BY name
  `).all().map(row => row.name);

  console.log(JSON.stringify({ ok: true, dbPath: path.relative(root, dbPath), tables }, null, 2));
} finally {
  db.close();
}

function applyMigration(id, description, fn) {
  const existing = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(id);
  if (existing) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.prepare('INSERT INTO schema_migrations(id, applied_at, description) VALUES(?, ?, ?)')
      .run(id, new Date().toISOString(), description);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
