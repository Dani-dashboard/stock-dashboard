import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'config/market-intelligence.json'), 'utf8'));
const latestPath = path.join(root, process.argv.find(arg => arg.startsWith('--latest='))?.slice('--latest='.length) || 'data/latest.json');
const dbPath = path.join(root, config.storage?.path || 'data/market-intelligence.sqlite');
const latest = JSON.parse(await fs.readFile(latestPath, 'utf8'));
const latestGeneratedAt = normalizeTimestamp(latest.generatedAt) || new Date().toISOString();
const observations = dedupeObservations(extractObservations(latest, latestGeneratedAt));

const db = new DatabaseSync(dbPath);
try {
  db.exec(`PRAGMA busy_timeout = ${Number(config.storage?.busyTimeoutMs || 5000)}`);
  db.exec('PRAGMA foreign_keys = ON');
  assertSchema(db);
  const inserted = ingestObservations(db, observations);
  console.log(JSON.stringify({ ok: true, latest: path.relative(root, latestPath), dbPath: path.relative(root, dbPath), extracted: observations.length, written: inserted }, null, 2));
} finally {
  db.close();
}

function assertSchema(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_observations'").get();
  if (!row) throw new Error('market_observations table missing. Run `npm run mi:migrate` first.');
}

function ingestObservations(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO market_observations(
      metric_id, metric_name, metric_type, source, provider, unit, value, change_value, change_pct,
      source_timestamp, observed_timestamp, fetch_timestamp, latest_generated_at, market_session,
      stale, stale_seconds, quality_level, quality_message, raw_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(metric_id, observed_timestamp, source, provider) DO UPDATE SET
      metric_name=excluded.metric_name,
      metric_type=excluded.metric_type,
      unit=excluded.unit,
      value=excluded.value,
      change_value=excluded.change_value,
      change_pct=excluded.change_pct,
      source_timestamp=excluded.source_timestamp,
      fetch_timestamp=excluded.fetch_timestamp,
      latest_generated_at=excluded.latest_generated_at,
      market_session=excluded.market_session,
      stale=excluded.stale,
      stale_seconds=excluded.stale_seconds,
      quality_level=excluded.quality_level,
      quality_message=excluded.quality_message,
      raw_json=excluded.raw_json
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const o of rows) {
      stmt.run(
        o.metricId,
        o.metricName || null,
        o.metricType || null,
        o.source || 'unknown',
        o.provider || 'unknown',
        o.unit || null,
        o.value,
        o.changeValue,
        o.changePct,
        o.sourceTimestamp || null,
        o.observedTimestamp,
        o.fetchTimestamp || null,
        o.latestGeneratedAt,
        o.marketSession || null,
        o.stale ? 1 : 0,
        o.staleSeconds,
        o.qualityLevel || null,
        o.qualityMessage || null,
        JSON.stringify(o.raw || {})
      );
    }
    db.exec('COMMIT');
    return rows.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function dedupeObservations(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = [row.metricId, row.observedTimestamp, row.source || 'unknown', row.provider || 'unknown'].join('\u001f');
    byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

function extractObservations(payload, latestGeneratedAt) {
  const out = [];
  for (const metric of payload.metrics || []) {
    add(out, {
      metricId: metric.id,
      metricName: metric.name,
      metricType: metric.group,
      source: metric.sourceUrl || metric.provider || 'metric',
      provider: metric.provider || 'metric',
      unit: metric.unit,
      value: numberOrNull(metric.value),
      changeValue: numberOrNull(metric.change),
      changePct: numberOrNull(metric.changePct),
      sourceTimestamp: normalizeTimestamp(metric.timestamp),
      // `sourceTimestamp` is the market/vendor quote time. `observedTimestamp` is when our
      // local monitor captured the value. Keep them separate so closed/reference quotes
      // (same source timestamp across many fetches) still build deterministic observation
      // history with flat 10m/30m/60m deltas instead of being repeatedly overwritten.
      observedTimestamp: normalizeTimestamp(metric.fetchedAt) || latestGeneratedAt,
      fetchTimestamp: normalizeTimestamp(metric.fetchedAt) || latestGeneratedAt,
      latestGeneratedAt,
      marketSession: metric.status?.marketState || null,
      stale: isStale(metric.status),
      staleSeconds: integerOrNull(metric.status?.ageSeconds),
      qualityLevel: metric.status?.level || null,
      qualityMessage: metric.status?.message || metric.delayNote || null,
      raw: metric
    });
  }

  for (const flow of payload.investorFlows || []) {
    const observedTimestamp = normalizeTimestamp(flow.fetchedAt) || latestGeneratedAt;
    const sourceTimestamp = flow.currentDatetime || flow.tradeDate || null;
    const rows = Array.isArray(flow.rows) ? flow.rows : [];
    const base = {
      metricType: 'InvestorFlow',
      source: flow.source || 'KRX investor flow',
      provider: 'krx',
      unit: flow.unit || '십억원',
      sourceTimestamp,
      observedTimestamp,
      fetchTimestamp: normalizeTimestamp(flow.fetchedAt) || latestGeneratedAt,
      latestGeneratedAt,
      marketSession: 'KRX_INVESTOR_FLOW',
      stale: flow.status !== 'ok',
      staleSeconds: null,
      qualityLevel: flow.status || null,
      qualityMessage: flow.message || null
    };
    add(out, { ...base, metricId: `flow.${flow.id}.foreign.net_buy`, metricName: `${flow.label} 외국인 순매수`, value: numberOrNull(flow.foreignNetBuy), raw: flow });
    add(out, { ...base, metricId: `flow.${flow.id}.foreign.buy`, metricName: `${flow.label} 외국인 매수`, value: numberOrNull(flow.foreignBuy), raw: flow });
    add(out, { ...base, metricId: `flow.${flow.id}.foreign.sell`, metricName: `${flow.label} 외국인 매도`, value: numberOrNull(flow.foreignSell), raw: flow });
    for (const row of rows) {
      const key = investorKey(row.investor);
      if (!key) continue;
      add(out, { ...base, metricId: `flow.${flow.id}.${key}.net_buy`, metricName: `${flow.label} ${row.investor} 순매수`, value: numberOrNull(row.netBuy), raw: row });
      add(out, { ...base, metricId: `flow.${flow.id}.${key}.buy`, metricName: `${flow.label} ${row.investor} 매수`, value: numberOrNull(row.buy), raw: row });
      add(out, { ...base, metricId: `flow.${flow.id}.${key}.sell`, metricName: `${flow.label} ${row.investor} 매도`, value: numberOrNull(row.sell), raw: row });
    }
  }

  const special = payload.koreaSpecialIndicators;
  if (special) extractKoreaSpecial(out, special, latestGeneratedAt);

  const pcr = payload.putCallRatio;
  if (pcr) {
    const base = derivedBase('Options', pcr.source || 'putCallRatio', 'pcr', pcr.fetchedAt || pcr.generatedAt, latestGeneratedAt, pcr.status, pcr.message);
    add(out, { ...base, metricId: 'options.kospi200.volume_pcr', metricName: 'KOSPI200 options volume PCR', unit: 'ratio', value: numberOrNull(pcr.volumePcr), raw: pcr });
    add(out, { ...base, metricId: 'options.kospi200.amount_pcr', metricName: 'KOSPI200 options amount PCR', unit: 'ratio', value: numberOrNull(pcr.amountPcr), raw: pcr });
    add(out, { ...base, metricId: 'options.kospi200.open_interest_pcr', metricName: 'KOSPI200 options open interest PCR', unit: 'ratio', value: numberOrNull(pcr.openInterestPcr), raw: pcr });
  }

  const volumes = payload.marketVolumes;
  for (const item of volumes?.items || []) {
    const base = derivedBase('MarketVolume', item.source || 'marketVolumes', 'volume', item.fetchedAt || volumes.generatedAt, latestGeneratedAt, item.status, item.message);
    add(out, { ...base, metricId: `volume.${item.id}.current`, metricName: `${item.label} current volume`, unit: 'shares/contracts', value: numberOrNull(item.currentVolume), raw: item });
    add(out, { ...base, metricId: `volume.${item.id}.avg_pct`, metricName: `${item.label} vs 6m avg`, unit: '%', value: numberOrNull(item.avgPct), raw: item });
    add(out, { ...base, metricId: `volume.${item.id}.max_pct`, metricName: `${item.label} vs 6m max`, unit: '%', value: numberOrNull(item.maxPct), raw: item });
  }

  for (const level of payload.fxLevels || []) {
    const base = derivedBase('FxLevel', level.source || 'fxLevels', 'fxLevels', level.fetchedAt, latestGeneratedAt, level.status === 'inside_range' ? 'ok' : 'warn', level.status);
    add(out, { ...base, metricId: `fx_level.${level.id}.support`, metricName: `${level.label} support`, unit: 'price', value: numberOrNull(level.support), raw: level });
    add(out, { ...base, metricId: `fx_level.${level.id}.resistance`, metricName: `${level.label} resistance`, unit: 'price', value: numberOrNull(level.resistance), raw: level });
    add(out, { ...base, metricId: `fx_level.${level.id}.average`, metricName: `${level.label} 5d average`, unit: 'price', value: numberOrNull(level.average), raw: level });
  }

  return out;
}

function extractKoreaSpecial(out, special, latestGeneratedAt) {
  const basis = special.basis || {};
  const basisBase = derivedBase('KoreaSpecialBasis', basis.source || 'koreaSpecialIndicators.basis', 'koreaSpecial', basis.fetchedAt || special.generatedAt, latestGeneratedAt, basis.status, basis.message);
  add(out, { ...basisBase, metricId: 'special.kospi200_basis.level', metricName: 'KOSPI200 futures basis', unit: 'pt', value: numberOrNull(basis.basis), raw: basis });
  add(out, { ...basisBase, metricId: 'special.kospi200_basis.pct', metricName: 'KOSPI200 futures basis percent', unit: '%', value: numberOrNull(basis.basisPct), raw: basis });

  const breadth = special.breadth || {};
  const breadthBase = derivedBase('Breadth', breadth.source || 'koreaSpecialIndicators.breadth', 'koreaSpecial', breadth.fetchedAt || special.generatedAt, latestGeneratedAt, breadth.status, breadth.note);
  for (const [key, item] of [['kospi', breadth.kospi], ['kospi200', breadth.kospi200 || breadth.kospi200Proxy]]) {
    if (!item) continue;
    add(out, { ...breadthBase, metricId: `breadth.${key}.advance_ratio_pct`, metricName: `${key} advance ratio`, unit: '%', value: numberOrNull(item.advanceRatioPct), raw: item });
    add(out, { ...breadthBase, metricId: `breadth.${key}.ad_spread`, metricName: `${key} advance-decline spread`, unit: 'count', value: numberOrNull(item.adSpread), raw: item });
    add(out, { ...breadthBase, metricId: `breadth.${key}.advancing`, metricName: `${key} advancing count`, unit: 'count', value: numberOrNull(item.advancing), raw: item });
    add(out, { ...breadthBase, metricId: `breadth.${key}.declining`, metricName: `${key} declining count`, unit: 'count', value: numberOrNull(item.declining), raw: item });
  }

  const program = special.programTrading || {};
  const programBase = derivedBase('ProgramTrading', program.source || 'koreaSpecialIndicators.programTrading', 'koreaSpecial', program.fetchedAt || special.generatedAt, latestGeneratedAt, program.status, program.message?.summary || program.message);
  const normalized = program.normalized || {};
  const programPaths = [
    ['program.foreign.total_net_buy_amount', normalized.foreign?.totalNetBuyAmount],
    ['program.foreign.arbitrage_net_buy_amount', normalized.foreign?.arbitrageNetBuyAmount],
    ['program.foreign.non_arbitrage_net_buy_amount', normalized.foreign?.nonArbitrageNetBuyAmount],
    ['program.institution.total_net_buy_amount', normalized.institution?.totalNetBuyAmount],
    ['program.market.total_net_buy_amount', normalized.market?.totalNetBuyAmount]
  ];
  for (const [metricId, value] of programPaths) add(out, { ...programBase, metricId, metricName: metricId, unit: program.amountUnit || '백만원', value: numberOrNull(value), raw: program });

  const rs = special.relativeStrength || {};
  const rsBase = derivedBase('RelativeStrength', rs.source || 'koreaSpecialIndicators.relativeStrength', 'koreaSpecial', rs.fetchedAt || special.generatedAt, latestGeneratedAt, rs.status, rs.message);
  const items = rs.items && typeof rs.items === 'object' ? Object.values(rs.items) : [];
  for (const item of items) {
    add(out, { ...rsBase, metricId: `relative_strength.${item.id || item.code}.pctp`, metricName: `${item.name || item.id} relative strength vs KOSPI200`, unit: 'pctp', value: numberOrNull(item.relativeStrengthPctp), raw: item });
  }

  const features = special.features || {};
  const featureBase = derivedBase('ExistingFeatureScaffold', 'koreaSpecialIndicators.features', 'koreaSpecial', special.generatedAt, latestGeneratedAt, 'ok', 'Existing 10m/30m feature scaffold from fetch-all');
  for (const [key, value] of Object.entries(features)) {
    add(out, { ...featureBase, metricId: `existing_feature.${camelToSnake(key)}`, metricName: key, unit: null, value: numberOrNull(value), raw: { key, value } });
  }
}

function derivedBase(metricType, source, provider, timestamp, latestGeneratedAt, status, message) {
  const observedTimestamp = normalizeTimestamp(timestamp) || latestGeneratedAt;
  return {
    metricType,
    source,
    provider,
    sourceTimestamp: normalizeTimestamp(timestamp),
    observedTimestamp,
    fetchTimestamp: observedTimestamp,
    latestGeneratedAt,
    marketSession: metricType,
    stale: status === 'error' || status === 'warn',
    staleSeconds: null,
    qualityLevel: status || null,
    qualityMessage: typeof message === 'string' ? message : message ? JSON.stringify(message) : null
  };
}

function add(out, observation) {
  if (!observation.metricId) return;
  const value = numberOrNull(observation.value);
  if (!Number.isFinite(value)) return;
  const observedTimestamp = normalizeTimestamp(observation.observedTimestamp) || observation.latestGeneratedAt;
  if (!observedTimestamp) return;
  out.push({
    ...observation,
    value,
    changeValue: numberOrNull(observation.changeValue),
    changePct: numberOrNull(observation.changePct),
    sourceTimestamp: normalizeTimestamp(observation.sourceTimestamp) || null,
    observedTimestamp,
    fetchTimestamp: normalizeTimestamp(observation.fetchTimestamp) || observation.latestGeneratedAt || observedTimestamp,
    latestGeneratedAt: normalizeTimestamp(observation.latestGeneratedAt) || observedTimestamp,
    source: observation.source || 'unknown',
    provider: observation.provider || 'unknown'
  });
}

function isStale(status) {
  if (!status) return false;
  return status.level === 'warn' || status.level === 'error';
}

function investorKey(value = '') {
  const s = String(value);
  if (s.includes('외국인')) return 'foreign';
  if (s.includes('기관')) return 'institution';
  if (s.includes('개인')) return 'retail';
  return null;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (/^\d{8}$/.test(String(value))) {
    const s = String(value);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000+09:00`;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function integerOrNull(value) {
  const n = numberOrNull(value);
  return n === null ? null : Math.round(n);
}

function camelToSnake(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}
