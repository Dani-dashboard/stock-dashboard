import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
await loadDotEnv(path.join(root, '.env'));
await loadDotEnv(path.join(root, '.env.ai'));

const config = JSON.parse(await fs.readFile(path.join(root, 'config/market-intelligence.json'), 'utf8'));
const dbPath = path.join(root, config.storage?.path || 'data/market-intelligence.sqlite');
const contextPath = path.join(root, process.argv.find(arg => arg.startsWith('--context='))?.slice('--context='.length) || 'data/hourly-context.json');
const outPath = path.join(root, process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length) || 'data/hourly-ai-insight.json');
const contextPayload = JSON.parse(await fs.readFile(contextPath, 'utf8'));
const context = contextPayload.context || contextPayload;
const contextHash = contextPayload.contextHash || null;
const timestamp = contextPayload.timestamp || context.timestamp || new Date().toISOString();
const aiEnabled = process.env.MARKET_AI_ENABLED === '1';
const openAiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.MARKET_AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

const startedAt = new Date().toISOString();
let status = 'fallback_deterministic';
let insight;
let validationError = null;

try {
  if (aiEnabled && openAiKey) {
    insight = await callOpenAi({ context, model, apiKey: openAiKey });
    status = 'ok';
  } else {
    insight = buildDeterministicInsight(context, aiEnabled ? 'missing_openai_api_key' : 'market_ai_disabled');
  }
  validateInsight(insight);
} catch (err) {
  validationError = err.message;
  status = status === 'ok' ? 'error' : status;
  insight = buildDeterministicInsight(context, `ai_error: ${err.message}`);
}

const completedAt = new Date().toISOString();
const payload = {
  schemaVersion: config.schemaVersion,
  generatedAt: completedAt,
  engine: {
    type: 'hourly-ai-insight',
    aiUsed: status === 'ok',
    status,
    model: status === 'ok' ? model : null,
    guardrail: 'AI summarizes context only; deterministic CPU scores remain authoritative.'
  },
  timestamp,
  sessionPhase: insight.sessionPhase || context.sessionPhase,
  contextHash,
  sourceContextTimestamp: timestamp,
  insight,
  validationError
};

const db = new DatabaseSync(dbPath);
try {
  db.exec(`PRAGMA busy_timeout = ${Number(config.storage?.busyTimeoutMs || 5000)}`);
  db.exec('PRAGMA foreign_keys = ON');
  assertSchema(db);
  persistInsight(db, { timestamp, insight, status, model: status === 'ok' ? model : null, validationError, contextHash, startedAt, completedAt });
  await writeJsonAtomic(outPath, payload);
  console.log(JSON.stringify({ ok: true, out: path.relative(root, outPath), timestamp, status, aiUsed: status === 'ok', model: status === 'ok' ? model : null }, null, 2));
} finally {
  db.close();
}

async function callOpenAi({ context, model, apiKey }) {
  const messages = [
    {
      role: 'system',
      content: [
        'You write concise Korean market dashboard summaries for a human investor.',
        'Never recalculate or override numeric market scores. Use the provided deterministic context only.',
        'Return strict JSON only. No markdown fences.',
        'Schema: {"title":string,"stance":string,"sessionPhase":string,"summaryBullets":string[],"baseCase":string,"watchTriggers":string[],"invalidation":string[],"dataQualityNote":string,"confidenceLabel":"높음"|"보통"|"낮음"}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify(context)
    }
  ];
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages
    })
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI response missing content');
  return JSON.parse(text);
}

function buildDeterministicInsight(context, reason) {
  const state = context.marketState || {};
  const scores = state.scores || {};
  const regime = state.regime || 'NEUTRAL';
  const confidence = Number(scores.confidence ?? 0);
  const positives = Array.isArray(state.positiveDrivers) ? state.positiveDrivers.slice(0, 2) : [];
  const negatives = Array.isArray(state.negativeDrivers) ? state.negativeDrivers.slice(0, 2) : [];
  const strongest = Array.isArray(context.strongestSignals) ? context.strongestSignals.slice(0, 3) : [];
  const bullets = [];
  bullets.push(`CPU regime은 ${regime}, risk budget은 ${state.riskBudget ?? '—'}/5입니다. 신뢰도는 ${fmt(confidence)}% 수준입니다.`);
  if (positives.length) bullets.push(`우호 요인: ${positives.map(driverLabel).join(' / ')}.`);
  if (negatives.length) bullets.push(`부담 요인: ${negatives.map(driverLabel).join(' / ')}.`);
  if (strongest.length) bullets.push(`최근 10분 특징값: ${strongest.map(featureLabel).join(' / ')}.`);
  if (!positives.length && !negatives.length && !strongest.length) bullets.push('아직 시간별 해석에 쓸 강한 특징값은 제한적입니다. 추가 관측 누적이 필요합니다.');
  const watch = Array.isArray(state.watchConditions) && state.watchConditions.length
    ? state.watchConditions.slice(0, 3).map(x => x.message || x.code || String(x))
    : ['Direction/Flow/Breadth 중 2개 이상이 같은 방향으로 재확인되는지 확인', 'USD/KRW·VIX 등 stress 지표가 동시에 커지는지 확인'];
  const invalidation = Array.isArray(state.invalidationConditions) && state.invalidationConditions.length
    ? state.invalidationConditions.slice(0, 3).map(x => x.message || x.code || String(x))
    : ['현재 regime과 반대 방향의 10분 score delta가 2회 이상 누적될 때'];
  return {
    title: titleForRegime(regime),
    stance: stanceForRegime(regime, confidence),
    sessionPhase: context.sessionPhase,
    summaryBullets: bullets.slice(0, 5),
    baseCase: baseCaseForRegime(regime),
    watchTriggers: watch,
    invalidation,
    dataQualityNote: qualityNote(context, reason),
    confidenceLabel: confidence >= 65 ? '높음' : confidence >= 40 ? '보통' : '낮음'
  };
}

function titleForRegime(regime) {
  if (regime === 'STRONG_RISK_ON') return '위험선호가 강하지만 확인 신호를 계속 점검';
  if (regime === 'RISK_ON') return '위험선호 우위';
  if (regime === 'FRAGILE_RISK_ON') return '상승은 있으나 내부 확인이 약한 구간';
  if (regime === 'FRAGILE_RISK_OFF') return '방어적으로 기울지만 급격한 스트레스는 제한';
  if (regime === 'RISK_OFF') return '위험회피 우위';
  if (regime === 'STRESS') return '스트레스 지표 우선 감시';
  return '중립 관찰 구간';
}

function stanceForRegime(regime, confidence) {
  const low = confidence < 40 ? ' · 신뢰도 낮음' : '';
  if (['STRONG_RISK_ON', 'RISK_ON'].includes(regime)) return `공격/추세 추종 가능${low}`;
  if (regime === 'FRAGILE_RISK_ON') return `선별적 위험선호${low}`;
  if (['RISK_OFF', 'STRESS'].includes(regime)) return `방어 우선${low}`;
  if (regime === 'FRAGILE_RISK_OFF') return `리스크 축소 우선${low}`;
  return `중립 대기${low}`;
}

function baseCaseForRegime(regime) {
  if (['STRONG_RISK_ON', 'RISK_ON'].includes(regime)) return '현재 흐름이 유지되려면 가격 방향과 수급/시장폭이 같은 방향으로 따라와야 합니다.';
  if (regime === 'FRAGILE_RISK_ON') return '가격은 버티지만 수급·시장폭·stress 중 하나가 확인을 덜 해주는 장으로 봅니다.';
  if (['RISK_OFF', 'STRESS'].includes(regime)) return '반등보다 방어와 변동성 관리를 우선해서 보는 구간입니다.';
  if (regime === 'FRAGILE_RISK_OFF') return '하방 압력은 있으나 확정적 급락장으로 단정하기 전 확인이 필요합니다.';
  return '뚜렷한 방향성보다 다음 확인 신호를 기다리는 구간입니다.';
}

function driverLabel(d) {
  const id = d.id || d.cluster || 'driver';
  const impact = d.impact == null ? '' : ` ${signed(d.impact)}`;
  return `${id}${impact}`;
}

function featureLabel(f) {
  const p = f.pctDelta10m == null ? '' : ` ${signed(f.pctDelta10m)}%`;
  const d = p || f.delta10m == null ? '' : ` 10분 ${signed(f.delta10m)}`;
  const z = f.sameTimeZ == null ? '' : ` z ${signed(f.sameTimeZ)}`;
  return `${f.metricId}${p}${d}${z}`.trim();
}

function qualityNote(context, reason) {
  const q = context.dataQuality || {};
  const counts = q.qualityCounts || {};
  const suffix = reason === 'market_ai_disabled'
    ? ' AI 호출은 아직 비활성화되어 deterministic fallback 문구로 표시됩니다.'
    : reason === 'missing_openai_api_key'
      ? ' AI 활성화 요청은 있었지만 OPENAI_API_KEY가 없어 fallback 문구로 표시됩니다.'
      : reason && reason.startsWith('ai_error:')
        ? ` AI 호출 오류로 fallback 문구를 표시합니다 (${reason.slice(10)}).`
        : '';
  return `feature ${q.featureCount ?? '—'}개 · ok ${counts.ok || 0}, warn ${counts.warn || 0}, limited ${counts.limited || 0}.${suffix}`;
}

function validateInsight(value) {
  const errors = [];
  if (!value || typeof value !== 'object') errors.push('insight must be object');
  for (const key of ['title', 'stance', 'sessionPhase', 'baseCase', 'dataQualityNote', 'confidenceLabel']) {
    if (typeof value?.[key] !== 'string') errors.push(`${key} must be string`);
  }
  for (const key of ['summaryBullets', 'watchTriggers', 'invalidation']) {
    if (!Array.isArray(value?.[key]) || !value[key].every(x => typeof x === 'string')) errors.push(`${key} must be string[]`);
  }
  if (!['높음', '보통', '낮음'].includes(value?.confidenceLabel)) errors.push('confidenceLabel invalid');
  if (errors.length) throw new Error(errors.join('; '));
}

function assertSchema(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hourly_ai_insight'").get();
  if (!row) throw new Error('hourly_ai_insight table missing. Run `npm run mi:migrate` first.');
}

function persistInsight(db, { timestamp, insight, status, model, validationError, contextHash, startedAt, completedAt }) {
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
  stmt.run(timestamp, insight.sessionPhase || 'unknown', model, null, status, JSON.stringify(insight), config.schemaVersion, validationError, contextHash, timestamp, startedAt, completedAt);
}

async function loadDotEnv(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^[\'\"]|[\'\"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function writeJsonAtomic(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.rename(tmp, file);
}

function fmt(value) { return Number.isFinite(value) ? value.toFixed(1) : '—'; }
function signed(value) { return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}` : '—'; }
