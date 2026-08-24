import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'config/market-intelligence.json'), 'utf8'));
const dbPath = path.join(root, config.storage?.path || 'data/market-intelligence.sqlite');
const asOfArg = process.argv.find(arg => arg.startsWith('--as-of='))?.slice('--as-of='.length);

const db = new DatabaseSync(dbPath);
try {
  db.exec(`PRAGMA busy_timeout = ${Number(config.storage?.busyTimeoutMs || 5000)}`);
  db.exec('PRAGMA foreign_keys = ON');
  assertSchema(db);

  const timestamp = asOfArg ? new Date(asOfArg).toISOString() : latestFeatureTimestamp(db);
  if (!timestamp) throw new Error('No market_features_10m rows found. Run `npm run mi:features` first.');
  const features = db.prepare('SELECT * FROM market_features_10m WHERE timestamp = ? ORDER BY metric_id').all(timestamp);
  if (!features.length) throw new Error(`No market_features_10m rows for ${timestamp}`);

  const previous = db.prepare('SELECT * FROM market_state_10m WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1').get(timestamp) || null;
  const state = buildMarketState(features, previous, timestamp);
  persistMarketState(db, state);
  console.log(JSON.stringify({ ok: true, timestamp, regime: state.regime, riskBudget: state.riskBudget, scores: state.scores, confidence: state.confidenceScore }, null, 2));
} finally {
  db.close();
}

function assertSchema(db) {
  for (const table of ['market_features_10m', 'market_state_10m']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!row) throw new Error(`${table} missing. Run \`npm run mi:migrate\` first.`);
  }
}

function latestFeatureTimestamp(db) {
  return db.prepare('SELECT timestamp FROM market_features_10m ORDER BY timestamp DESC LIMIT 1').get()?.timestamp || null;
}

function buildMarketState(features, previous, timestamp) {
  const featureMap = new Map(features.map(f => [f.metric_id, f]));
  const direction = scoreCluster('direction', featureMap);
  const flow = scoreCluster('flow', featureMap);
  const stressRaw = scoreCluster('stress', featureMap);
  const breadth = scoreCluster('breadth', featureMap);
  const stress = { ...stressRaw, score: clamp(Math.max(0, stressRaw.score ?? 0), 0, 100) };
  const confidence = confidenceScore(features, { direction, flow, stress, breadth });
  const previousRegime = previous?.regime || null;
  const regimeDecision = decideRegime({ direction, flow, stress, breadth, confidence, previousRegime });
  const riskBudget = decideRiskBudget(regimeDecision.regime, { direction, flow, stress, breadth, confidence });

  const previousScores = previous ? {
    direction: numberOrNull(previous.direction_score),
    flow: numberOrNull(previous.flow_score),
    stress: numberOrNull(previous.stress_score),
    breadth: numberOrNull(previous.breadth_score)
  } : {};

  const drivers = buildDrivers({ direction, flow, stress, breadth });
  const warnings = buildWarnings(features, { direction, flow, stress, breadth, confidence, regimeDecision });
  const watchConditions = buildWatchConditions({ direction, flow, stress, breadth, confidence, regimeDecision });
  const dataQuality = buildDataQuality(features, { direction, flow, stress, breadth, confidence });

  return {
    timestamp,
    previousTimestamp: previous?.timestamp || null,
    regime: regimeDecision.regime,
    previousRegime,
    riskBudget,
    scores: {
      direction: direction.score,
      flow: flow.score,
      stress: stress.score,
      breadth: breadth.score
    },
    deltas: {
      direction: delta(direction.score, previousScores.direction),
      flow: delta(flow.score, previousScores.flow),
      stress: delta(stress.score, previousScores.stress),
      breadth: delta(breadth.score, previousScores.breadth)
    },
    confidenceScore: confidence.score,
    positiveDrivers: drivers.positive,
    negativeDrivers: drivers.negative,
    warnings,
    watchConditions,
    invalidationConditions: buildInvalidationConditions(regimeDecision.regime),
    contributionBreakdown: { direction, flow, stress, breadth },
    dataQuality,
    stateMachine: regimeDecision
  };
}

function scoreCluster(clusterName, featureMap) {
  const specs = config.scoring?.clusters?.[clusterName] || [];
  const contributions = [];
  let weighted = 0;
  let totalWeight = 0;
  for (const spec of specs) {
    const contribution = spec.kind === 'cluster'
      ? scoreNestedCluster(spec, featureMap)
      : scoreFeature(spec, featureMap.get(spec.id));
    if (!contribution) continue;
    contributions.push(contribution);
    weighted += contribution.score * contribution.effectiveWeight;
    totalWeight += Math.abs(contribution.effectiveWeight);
  }
  const score = totalWeight ? round(weighted / totalWeight) : null;
  return {
    score: score === null ? null : clamp(score, -100, 100),
    sampleCount: contributions.length,
    totalCandidates: specs.length,
    contributions: contributions.sort((a, b) => Math.abs(b.score * b.effectiveWeight) - Math.abs(a.score * a.effectiveWeight))
  };
}

function scoreNestedCluster(spec, featureMap) {
  const members = [];
  for (const id of spec.members || []) {
    const c = scoreFeature({ id, weight: 1, kind: 'riskAsset' }, featureMap.get(id));
    if (c) members.push(c);
  }
  if (!members.length) return null;
  const score = round(members.reduce((sum, x) => sum + x.score, 0) / members.length);
  const effectiveWeight = Number(spec.weight || 1) * Math.min(1, members.reduce((sum, x) => sum + x.qualityFactor, 0) / members.length);
  return { id: spec.id, kind: spec.kind, score, baseWeight: Number(spec.weight || 1), effectiveWeight, qualityFactor: effectiveWeight / Number(spec.weight || 1), level: null, signal: 'cluster average', members: members.map(m => ({ id: m.id, score: m.score, level: m.level })) };
}

function scoreFeature(spec, feature) {
  if (!feature) return null;
  const qualityFactor = qualityFactorFor(feature.quality_level);
  if (qualityFactor <= 0) return null;
  const baseWeight = Number(spec.weight || 1);
  const effectiveWeight = baseWeight * qualityFactor;
  const score = rawFeatureScore(spec, feature);
  if (score === null) return null;
  return {
    id: spec.id,
    kind: spec.kind,
    score: round(clamp(score, -100, 100)),
    baseWeight,
    effectiveWeight: round(effectiveWeight),
    qualityFactor,
    level: numberOrNull(feature.level),
    delta10m: numberOrNull(feature.delta10m),
    pctDelta10m: numberOrNull(feature.pct_delta10m),
    sameTimeZ: numberOrNull(feature.same_time_z),
    rollingPercentile: numberOrNull(feature.rolling_percentile),
    qualityLevel: feature.quality_level
  };
}

function rawFeatureScore(spec, feature) {
  const units = config.scoring?.scoreUnits || {};
  const pct = firstNumber(feature.pct_delta10m, feature.pct_delta30m, feature.pct_delta60m);
  const deltaValue = firstNumber(feature.delta10m, feature.delta30m, feature.delta60m);
  const z = numberOrNull(feature.same_time_z);
  const level = numberOrNull(feature.level);

  if (spec.kind === 'riskAsset') {
    const score = pct !== null ? (pct / Number(units.pricePctMove || 0.35)) * 20 : z !== null ? (z / Number(units.zScore || 1.5)) * 20 : null;
    return score;
  }
  if (spec.kind === 'basis') {
    const base = deltaValue !== null ? (deltaValue / Number(units.basisPct || 0.3)) * 20 : level !== null ? (level / Number(units.basisPct || 0.3)) * 10 : null;
    return base;
  }
  if (spec.kind === 'cumulativeFlow' || spec.kind === 'programFlow') {
    const impulse = deltaValue !== null ? deltaValue : null;
    if (impulse !== null) return (impulse / Number(units.flowImpulseBillionKrw || 300)) * 20;
    if (z !== null) return (z / Number(units.zScore || 1.5)) * 20;
    return null;
  }
  if (spec.kind === 'stressUp') {
    const score = pct !== null ? (pct / Number(units.fxPctMove || 0.25)) * 20 : z !== null ? (z / Number(units.zScore || 1.5)) * 20 : null;
    return score;
  }
  if (spec.kind === 'breadthStressInverse') {
    if (level === null) return null;
    return ((50 - level) / Number(units.breadthRatioPct || 12)) * 20;
  }
  if (spec.kind === 'breadthRatio') {
    if (level === null) return null;
    const momentum = deltaValue !== null ? deltaValue * 1.5 : 0;
    return (((level - 50) + momentum) / Number(units.breadthRatioPct || 12)) * 20;
  }
  if (spec.kind === 'breadthSpread') {
    if (level === null) return null;
    return clamp(level / 25, -100, 100);
  }
  return null;
}

function confidenceScore(features, clusters) {
  const relevantIds = new Set(Object.values(config.scoring?.clusters || {}).flatMap(items => items.flatMap(item => item.kind === 'cluster' ? item.members || [] : [item.id])));
  const relevant = features.filter(f => relevantIds.has(f.metric_id));
  const candidates = relevant.length || features.length;
  const okish = relevant.filter(f => qualityFactorFor(f.quality_level) >= 0.45).length;
  const withWindow = relevant.filter(f => f.delta10m !== null || f.delta30m !== null || f.delta60m !== null).length;
  const withNorm = relevant.filter(f => f.same_time_z !== null || f.rolling_percentile !== null).length;
  const clusterCoverage = Object.values(clusters).filter(c => c.sampleCount > 0).length / Math.max(1, Object.keys(clusters).length);
  const score = clamp(
    (okish / Math.max(1, candidates)) * 35 +
    (withWindow / Math.max(1, candidates)) * 30 +
    (withNorm / Math.max(1, candidates)) * 20 +
    clusterCoverage * 15,
    0,
    100
  );
  return { score: round(score), candidates, okish, withWindow, withNorm, clusterCoverage: round(clusterCoverage) };
}

function decideRegime({ direction, flow, stress, breadth, confidence, previousRegime }) {
  const t = config.scoring?.regimeThresholds || {};
  const d = direction.score ?? 0;
  const f = flow.score ?? 0;
  const s = stress.score ?? 0;
  const b = breadth.score ?? 0;
  const composite = round(d * 0.35 + f * 0.25 + b * 0.20 - s * 0.20);
  let raw = 'NEUTRAL';
  const reasons = [];

  if (confidence.score < Number(t.lowConfidence || 35)) {
    raw = 'NEUTRAL';
    reasons.push('low confidence keeps regime neutral');
  } else if (s >= Number(t.stress || 65) && composite < Number(t.riskOn || 25)) {
    raw = 'STRESS';
    reasons.push('stress score above threshold');
  } else if (composite >= Number(t.strongRiskOn || 55) && s < Number(t.stress || 65)) {
    raw = 'STRONG_RISK_ON';
  } else if (composite >= Number(t.riskOn || 25)) {
    raw = 'RISK_ON';
  } else if (composite <= Number(t.strongRiskOff || -55) || (s >= Number(t.stress || 65) && d < 0)) {
    raw = 'RISK_OFF';
  } else if (composite <= Number(t.riskOff || -25)) {
    raw = 'FRAGILE_RISK_OFF';
  }

  const fragileConflict = d > Number(t.riskOn || 25) && (f < -Number(t.fragileBand || 20) || b < -Number(t.fragileBand || 20) || s > Number(t.stress || 65) * 0.75);
  if (raw === 'STRONG_RISK_ON' && fragileConflict) {
    raw = 'FRAGILE_RISK_ON';
    reasons.push('risk-on veto: price strength not confirmed by flow/breadth/stress');
  }
  if (raw === 'RISK_ON' && fragileConflict) {
    raw = 'FRAGILE_RISK_ON';
    reasons.push('risk-on fragility: internal confirmation weak');
  }

  // Hysteresis scaffold: for now record previous regime and candidate. Do not force transition until more state history accumulates.
  return { regime: raw, candidateRegime: raw, previousRegime, compositeScore: composite, hysteresisApplied: false, reasons };
}

function decideRiskBudget(regime, { confidence }) {
  const budgets = config.scoring?.riskBudget || {};
  if (confidence.score < 25) return budgets.neutral || 3;
  if (regime === 'STRONG_RISK_ON') return budgets.aggressiveRiskOn || 5;
  if (regime === 'RISK_ON' || regime === 'FRAGILE_RISK_ON') return budgets.riskOn || 4;
  if (regime === 'RISK_OFF' || regime === 'FRAGILE_RISK_OFF') return budgets.riskOff || 2;
  if (regime === 'STRESS') return budgets.defensive || 1;
  return budgets.neutral || 3;
}

function buildDrivers(clusters) {
  const all = Object.entries(clusters).flatMap(([cluster, c]) => (c.contributions || []).map(x => ({ cluster, ...x, impact: round(x.score * x.effectiveWeight) })));
  return {
    positive: all.filter(x => x.impact > 0).sort((a, b) => b.impact - a.impact).slice(0, 8),
    negative: all.filter(x => x.impact < 0).sort((a, b) => a.impact - b.impact).slice(0, 8)
  };
}

function buildWarnings(features, { confidence }) {
  const warnings = [];
  const qualityCounts = countBy(features, f => f.quality_level || 'unknown');
  if (confidence.score < 35) warnings.push({ code: 'LOW_CONFIDENCE', message: 'Feature history/normalization coverage is still limited.', confidence: confidence.score });
  if ((qualityCounts.error || 0) > 0) warnings.push({ code: 'FEATURE_ERRORS', count: qualityCounts.error });
  if ((qualityCounts.warn || 0) > 0) warnings.push({ code: 'FEATURE_WARNINGS', count: qualityCounts.warn });
  return warnings;
}

function buildWatchConditions({ direction, flow, stress, breadth }) {
  const out = [];
  if ((direction.score ?? 0) > 20 && ((flow.score ?? 0) < -15 || (breadth.score ?? 0) < -15)) out.push({ code: 'FRAGILE_RALLY', message: 'Price direction is positive but flow/breadth confirmation is weak.' });
  if ((direction.score ?? 0) < -20 && ((flow.score ?? 0) > 15 || (breadth.score ?? 0) > 15) && (stress.score ?? 0) < 50) out.push({ code: 'REVERSAL_WATCH', message: 'Price is weak but internal confirmation is improving.' });
  if ((stress.score ?? 0) > 50) out.push({ code: 'STRESS_ELEVATED', message: 'Stress cluster is elevated; monitor FX/volatility/breadth together.' });
  return out;
}

function buildInvalidationConditions(regime) {
  if (regime.includes('RISK_ON')) return ['Flow score turns negative', 'Breadth score deteriorates below neutral', 'Stress score rises sharply'];
  if (regime.includes('RISK_OFF') || regime === 'STRESS') return ['Foreign futures impulse improves', 'USD/KRW/VKOSPI stress eases', 'Breadth recovers above neutral'];
  return ['Direction/flow/breadth alignment improves or deteriorates for two 10-minute windows'];
}

function buildDataQuality(features, clusters) {
  const qualityCounts = countBy(features, f => f.quality_level || 'unknown');
  return {
    featureCount: features.length,
    qualityCounts,
    clusterCoverage: {
      direction: clusters.direction.sampleCount,
      flow: clusters.flow.sampleCount,
      stress: clusters.stress.sampleCount,
      breadth: clusters.breadth.sampleCount
    },
    note: 'Scores are deterministic CPU estimates. Low history coverage should lower confidence, not create fake precision.'
  };
}

function persistMarketState(db, state) {
  db.prepare(`
    INSERT INTO market_state_10m(
      timestamp, previous_timestamp, regime, previous_regime, risk_budget,
      direction_score, direction_delta10m, flow_score, flow_delta10m,
      stress_score, stress_delta10m, breadth_score, breadth_delta10m,
      confidence_score, positive_drivers_json, negative_drivers_json,
      warnings_json, watch_conditions_json, invalidation_conditions_json,
      contribution_breakdown_json, data_quality_json, state_machine_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(timestamp) DO UPDATE SET
      previous_timestamp=excluded.previous_timestamp,
      regime=excluded.regime,
      previous_regime=excluded.previous_regime,
      risk_budget=excluded.risk_budget,
      direction_score=excluded.direction_score,
      direction_delta10m=excluded.direction_delta10m,
      flow_score=excluded.flow_score,
      flow_delta10m=excluded.flow_delta10m,
      stress_score=excluded.stress_score,
      stress_delta10m=excluded.stress_delta10m,
      breadth_score=excluded.breadth_score,
      breadth_delta10m=excluded.breadth_delta10m,
      confidence_score=excluded.confidence_score,
      positive_drivers_json=excluded.positive_drivers_json,
      negative_drivers_json=excluded.negative_drivers_json,
      warnings_json=excluded.warnings_json,
      watch_conditions_json=excluded.watch_conditions_json,
      invalidation_conditions_json=excluded.invalidation_conditions_json,
      contribution_breakdown_json=excluded.contribution_breakdown_json,
      data_quality_json=excluded.data_quality_json,
      state_machine_json=excluded.state_machine_json
  `).run(
    state.timestamp,
    state.previousTimestamp,
    state.regime,
    state.previousRegime,
    state.riskBudget,
    state.scores.direction,
    state.deltas.direction,
    state.scores.flow,
    state.deltas.flow,
    state.scores.stress,
    state.deltas.stress,
    state.scores.breadth,
    state.deltas.breadth,
    state.confidenceScore,
    JSON.stringify(state.positiveDrivers),
    JSON.stringify(state.negativeDrivers),
    JSON.stringify(state.warnings),
    JSON.stringify(state.watchConditions),
    JSON.stringify(state.invalidationConditions),
    JSON.stringify(state.contributionBreakdown),
    JSON.stringify(state.dataQuality),
    JSON.stringify(state.stateMachine)
  );
}

function countBy(items, fn) {
  const out = {};
  for (const item of items) {
    const key = fn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function qualityFactorFor(level) {
  return Number(config.scoring?.qualityFactors?.[level] ?? 0.3);
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function delta(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  return round(current - previous);
}

function clamp(value, min, max) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}
