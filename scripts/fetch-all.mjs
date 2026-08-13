import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchYahooMetric } from '../src/providers/yahoo.mjs';
import { fetchBinanceMetric } from '../src/providers/binance.mjs';
import { fetchKisMetric, fetchKisFuturesBoardMetric, fetchKisBondYieldMetric, requestKis } from '../src/providers/kis.mjs';
import { fetchNaverIndexMetric, fetchNaverFxMetric, fetchNaverMarketIndexMetric, fetchNaverIndexDistanceMetric } from '../src/providers/naver.mjs';
import { fetchCnbcQuoteMetric } from '../src/providers/cnbc.mjs';
import { fetchFredMetric } from '../src/providers/fred.mjs';
import { fetchChartlogKospiNightFuturesMetric } from '../src/providers/chartlog.mjs';
import { fetchKrxMarketOperationNotices, extractKoreaMarketSafetyEvents } from '../src/providers/krxOfficial.mjs';
import { isMarketOpen, closedMarketMetric, latestKrxNightSessionHolidayReason, wasLatestKrxNightSessionHolidayClosed } from '../src/market-hours.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
await loadDotEnv(path.join(root, '.env'));

const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 8000);
const staleSeconds = Number(process.env.DATA_STALE_SECONDS || 180);
const metrics = JSON.parse(await fs.readFile(path.join(root, 'config/metrics.json'), 'utf8'));

const KOSPI_VOLATILITY_LEVELS = [
  { min: -Infinity, max: 20, key: 'very_stable', label: '매우 안정 / 변동성 압축', impact: 'Watch', guidance: '지금 같은 코스피 9000대 장세에서는 오히려 과도한 안심일 수 있음' },
  { min: 20, max: 35, key: 'stable', label: '전통적으론 보통~주의, 현재는 안정권', impact: 'Watch', guidance: '최근 한국장 기준으로는 꽤 편안한 구간' },
  { min: 35, max: 50, key: 'expanded', label: '변동성 확대', impact: 'Watch', guidance: '예전 기준으론 위험, 현재 기준으론 주의 구간' },
  { min: 50, max: 70, key: 'high_risk', label: '고위험 / 급등락 가능성 큼', impact: 'High', guidance: '포지션 사이즈 줄이고 추격매수 조심할 구간' },
  { min: 70, max: 85, key: 'extreme_high', label: '극단적 고변동', impact: 'High', guidance: '지수 방향보다 흔들림 자체가 큰 시장' },
  { min: 85, max: Infinity, key: 'panic_premium', label: '패닉 또는 과열형 옵션 프리미엄 폭증', impact: 'High', guidance: '서킷브레이커·사이드카급 장세와 연결될 수 있는 초위험 구간' }
];

const HIGH_YIELD_SPREAD_LEVELS = [
  { min: -Infinity, max: 250, key: 'very_tight', label: '매우 타이트', impact: 'Watch', guidance: '과도한 낙관 / 보상 부족 가능성' },
  { min: 250, max: 350, key: 'tight_normal_low', label: '타이트~정상 하단', impact: 'Watch', guidance: '위험선호 우세, 아직 risk-on' },
  { min: 350, max: 450, key: 'normal_watch', label: '정상~주의', impact: 'Watch', guidance: '신용 리스크를 조금씩 가격에 반영' },
  { min: 450, max: 550, key: 'risk_aversion_start', label: '위험 회피 시작', impact: 'High', guidance: '주식시장도 흔들릴 가능성 커짐' },
  { min: 550, max: 700, key: 'clear_risk_off', label: '명확한 risk-off', impact: 'High', guidance: '경기침체·부도율 상승 우려 반영' },
  { min: 700, max: Infinity, key: 'stress', label: '신용 스트레스', impact: 'High', guidance: '크레딧발 주식 하락 리스크 매우 큼' }
];

const releaseFetchLock = await acquireFetchLock();
try {
  const results = [];
  for (const metric of metrics) {
    results.push(await fetchWithFallback(metric));
  }

  const generatedAt = new Date().toISOString();
  const summary = summarize(results);
  const fxLevels = await fetchFxLevels(results);
  const investorFlows = await fetchInvestorFlows();
  const putCallRatio = await fetchKospi200PutCallRatio(generatedAt);
  const intradayShapes = await fetchIntradayShapes();
  const officialMarketNotices = await fetchKrxMarketOperationNotices({ timeoutMs });
  const marketVolumes = await fetchMarketVolumes(results, generatedAt);
  const krxShortSellingDaily = await readKrxShortSellingDaily(generatedAt);
  const officialMarketSafetyEvents = extractKoreaMarketSafetyEvents(officialMarketNotices.notices, new Date(generatedAt));
  const rawMarketSignals = buildMarketSignals(results, fxLevels, investorFlows, generatedAt, intradayShapes);
  const optionPositionSignal = await buildOptionPositionChangeSignal(putCallRatio, results, generatedAt);
  if (optionPositionSignal) rawMarketSignals.push(optionPositionSignal);
  const marketSignals = await applyMarketSignalOccurrenceState(rawMarketSignals, generatedAt);
  const payload = {
    generatedAt,
    refreshSeconds: 60,
    summary,
    fxLevels,
    investorFlows,
    putCallRatio,
    marketVolumes,
    krxShortSellingDaily,
    intradayShapes,
    officialMarketNotices,
    officialMarketSafetyEvents,
    marketSignals,
    groups: summarizeGroups(results),
    metrics: results
  };

  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await writeJsonAtomic(path.join(root, 'data/latest.json'), payload);
  await appendHealthLog(root, payload);
  console.log(`Wrote data/latest.json: ${summary.ok} ok, ${summary.warn} warn, ${summary.closed} closed, ${summary.error} error`);
} finally {
  await releaseFetchLock();
}

async function acquireFetchLock() {
  const dataDir = path.join(root, 'data');
  const lockDir = path.join(dataDir, '.fetch-all.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  const waitMs = Number(process.env.FETCH_LOCK_WAIT_MS || 55000);
  const staleMs = Number(process.env.FETCH_LOCK_STALE_MS || 120000);
  const start = Date.now();

  await fs.mkdir(dataDir, { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2));
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const stat = await fs.stat(lockDir);
        stale = Date.now() - stat.mtimeMs > staleMs;
      } catch {
        stale = true;
      }
      if (stale) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > waitMs) {
        throw new Error(`fetch lock busy for more than ${waitMs}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function writeJsonAtomic(file, payload) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.rename(tmp, file);
}

async function fetchWithFallback(metric) {
  const primary = await fetchMetric(metric);
  const primaryLevel = primary.status?.level;
  const shouldTryFallback = metric.fallback && (
    primaryLevel === 'error' ||
    (metric.fallbackOnWarn === true && primaryLevel === 'warn')
  );
  if (!shouldTryFallback) return primary;

  const fallbackMetric = {
    ...metric,
    ...metric.fallback,
    id: metric.id,
    name: metric.name,
    group: metric.group,
    unit: metric.unit,
    primaryProvider: metric.provider,
    primarySymbol: metric.symbol
  };
  const fallback = await fetchMetric(fallbackMetric);
  if (primaryLevel === 'warn' && fallback.status?.level !== 'ok') return primary;
  if (fallback.status?.level === 'error') {
    fallback.primaryError = primary.status?.message || 'primary failed';
    return fallback;
  }

  const primaryProblem = primaryLevel === 'error' ? 'primary failed' : 'primary warning';
  return {
    ...fallback,
    provider: fallback.provider,
    fallbackFrom: `${metric.provider}:${metric.symbol}`,
    status: {
      ...fallback.status,
      level: fallback.status.level === 'ok' ? 'warn' : fallback.status.level,
      icon: fallback.status.level === 'ok' ? '🟡' : fallback.status.icon,
      label: fallback.status.level === 'ok' ? '대체소스' : fallback.status.label,
      message: `${primaryProblem} (${primary.status?.message}); using fallback ${fallback.provider}:${fallback.symbol}`
    }
  };
}


async function fetchKisNgtLatestMetric(metric, { marketOpen = true } = {}) {
  const file = path.join(root, 'data/kis-ngt-latest.json');

  if (!marketOpen) {
    const holidayReason = latestKrxNightSessionHolidayReason(new Date());
    if (holidayReason) {
      return {
        ...metric,
        value: null,
        change: null,
        changePct: null,
        timestamp: null,
        fetchedAt: new Date().toISOString(),
        displayNote: `${metric.displayNote || ''} 한국 휴장일에는 해당 야간선물 세션도 휴장으로 보고 전일 야간선물 참고값을 오늘의 새 이슈로 표시하지 않음.`,
        status: {
          level: 'closed',
          icon: '⚪',
          label: '휴장/야간선물 없음',
          marketState: 'kr_derivatives_night_HOLIDAY_CLOSED',
          message: `KRX holiday-closed night futures session (${holidayReason}); no fresh night-futures reference`
        }
      };
    }
    const chartlog = await fetchChartlogKospiNightFuturesMetric(metric, { timeoutMs });
    if (chartlog.value !== null && chartlog.value !== undefined) return {
      ...chartlog,
      fallbackFrom: 'kisNgtLatest:night-session-closed',
      displayNote: `${metric.displayNote || ''} 야간장 종료 후에는 실시간값이 아니라 Chartlog 기준 전일 야간선물 최종/최근값을 회색으로 표시.`,
      status: {
        ...chartlog.status,
        level: 'closed',
        icon: '⚪',
        label: '전일 야간선물 최종',
        marketState: 'kr_derivatives_night_CLOSED_REFERENCE',
        message: `night session closed; showing Chartlog previous night futures reference. ${chartlog.status?.message || ''}`
      }
    };
    const dayRef = await previousDayFuturesReference();
    const suffix = dayRef ? `; fallback reference: day futures final/latest ${dayRef}` : '';
    return { ...metric, value:null, change:null, changePct:null, timestamp:null, fetchedAt:new Date().toISOString(), displayNote: `${metric.displayNote || ''} 야간장 종료 후 Chartlog 전일 야간선물 최종값을 시도했지만 현재 값을 읽지 못함.`, status:{ level:'closed', icon:'⚪', label:'장종료/참고값 없음', marketState:'kr_derivatives_night_CLOSED_REFERENCE', message:`night session closed; Chartlog reference unavailable${suffix}` } };
  }

  try {
    const latest = JSON.parse(await fs.readFile(file, 'utf8'));
    const tick = latest.lastTick;
    if (tick?.futs_prpr !== null && tick?.futs_prpr !== undefined) {
      const ageSeconds = Math.round((Date.now() - new Date(tick.receivedAt).getTime()) / 1000);
      return { ...metric, provider: 'kisNgtLatest', symbol: latest.trKey || metric.symbol, value: tick.futs_prpr, change: tick.futs_prdy_vrss, changePct: tick.futs_prdy_ctrt, timestamp: tick.receivedAt, fetchedAt: new Date().toISOString(), status: ageSeconds > 180 ? { level:'warn', icon:'🟡', label:'야간선물 지연', marketState:'KIS_NGT_WS', ageSeconds, message:`latest websocket tick is ${ageSeconds}s old` } : { level:'ok', icon:'🟢', label:'정상', marketState:'KIS_NGT_WS', ageSeconds, message:'latest websocket tick' } };
    }
    const chartlog = await fetchChartlogKospiNightFuturesMetric(metric, { timeoutMs });
    if (chartlog.value !== null && chartlog.value !== undefined) return {
      ...chartlog,
      fallbackFrom: 'kisNgtLatest:websocket-no-tick',
      status: {
        ...chartlog.status,
        level: 'warn',
        icon: '🟡',
        label: '대체소스',
        message: `KIS NGT tick absent (${latest.status || 'no tick yet'}); using Chartlog fallback. ${chartlog.status?.message || ''}`
      }
    };
    const dayRef = await previousDayFuturesReference();
    const suffix = dayRef ? `; fallback reference: day futures final/latest ${dayRef}` : '';
    return { ...metric, value:null, change:null, changePct:null, timestamp:null, fetchedAt:new Date().toISOString(), displayNote: `${metric.displayNote || ''} 야간 tick이 없을 때는 값을 대체하지 않고 주간선물 최종값만 상태 메시지로 참고 표시.`, status:{ level:'warn', icon:'🟡', label:'구독대기', marketState:'KIS_NGT_WS', message:`${latest.status || 'no tick yet'}; tr_key=${latest.trKey || metric.symbol}${suffix}` } };
  } catch (err) {
    const dayRef = await previousDayFuturesReference();
    const suffix = dayRef ? `; fallback reference: day futures final/latest ${dayRef}` : '';
    return { ...metric, value:null, change:null, changePct:null, timestamp:null, fetchedAt:new Date().toISOString(), status:{ level:'warn', icon:'🟡', label:'수집기대기', marketState:'KIS_NGT_WS', message:`night futures collector has not written latest file yet${suffix}` } };
  }
}

async function previousDayFuturesReference() {
  try {
    const payload = JSON.parse(await fs.readFile(path.join(root, 'data/latest.json'), 'utf8'));
    const m = payload.metrics?.find(x => x.id === 'kospi200_futures_kis' && x.value !== null && x.value !== undefined);
    if (!m) return null;
    const pct = m.changePct === null || m.changePct === undefined ? '' : ` (${Number(m.changePct).toFixed(2)}%)`;
    return `${m.value}${m.unit || ''}${pct}`;
  } catch {
    return null;
  }
}

async function fetchMetric(metric) {
  if (metric.activeMarket && !isMarketOpen(metric.activeMarket)) {
    if (metric.provider === 'kisNgtLatest') return fetchKisNgtLatestMetric(metric, { marketOpen: false });
    return closedMarketMetric(metric, metric.activeMarket);
  }
  const metricStaleSeconds = Number(metric.staleSeconds || staleSeconds);
  if (metric.provider === 'yahoo') return fetchYahooMetric(metric, { timeoutMs, staleSeconds: metricStaleSeconds });
  if (metric.provider === 'binance') return fetchBinanceMetric(metric, { timeoutMs, staleSeconds: metricStaleSeconds });
  if (metric.provider === 'naver') return fetchNaverIndexMetric(metric, { timeoutMs, staleSeconds: metricStaleSeconds });
  if (metric.provider === 'naverFx') return fetchNaverFxMetric(metric, { timeoutMs, staleSeconds: metricStaleSeconds });
  if (metric.provider === 'naverMarketIndex') return fetchNaverMarketIndexMetric(metric, { timeoutMs, staleSeconds: metricStaleSeconds });
  if (metric.provider === 'naverIndexDistance') return fetchNaverIndexDistanceMetric(metric, { timeoutMs, staleSeconds: metricStaleSeconds });
  if (metric.provider === 'cnbc') return fetchCnbcQuoteMetric(metric, { timeoutMs, staleSeconds: metricStaleSeconds });
  if (metric.provider === 'fred') return fetchFredMetric(metric, { timeoutMs, staleSeconds: metricStaleSeconds });
  if (metric.provider === 'chartlogKospiNightFutures') return fetchChartlogKospiNightFuturesMetric(metric, { timeoutMs });
  if (metric.provider === 'kisBond') return fetchKisBondYieldMetric(metric, { timeoutMs });
  if (metric.provider === 'kisNgtLatest') return fetchKisNgtLatestMetric(metric);
  if (metric.provider === 'kisFuturesBoard') return fetchKisFuturesBoardMetric(metric, { timeoutMs });
  if (metric.provider === 'kis') return fetchKisMetric(metric, { timeoutMs });
  if (metric.provider === 'pending') return { ...metric, value: null, change: null, changePct: null, timestamp: null, fetchedAt: new Date().toISOString(), status: { level: 'warn', icon: '🟡', label: '소스확인중', message: metric.displayNote || 'source pending' } };
  return { ...metric, value: null, status: { level: 'error', icon: '🔴', label: '장애', message: `Unknown provider ${metric.provider}` }, fetchedAt: new Date().toISOString() };
}


function summarizeGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.group || 'Other';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: item.groupLabel || key,
        description: item.groupDescription || '',
        order: item.groupOrder ?? 999,
        total: 0,
        ok: 0,
        warn: 0,
        closed: 0,
        error: 0
      });
    }
    const g = groups.get(key);
    g.total += 1;
    const level = item.status?.level || 'error';
    if (level === 'ok') g.ok += 1;
    else if (level === 'warn') g.warn += 1;
    else if (level === 'closed') g.closed += 1;
    else g.error += 1;
  }
  return Array.from(groups.values()).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

async function appendHealthLog(root, payload) {
  const file = path.join(root, 'data/health-history.jsonl');
  const compact = {
    generatedAt: payload.generatedAt,
    summary: payload.summary,
    groups: payload.groups.map(({ key, ok, warn, closed, error, total }) => ({ key, ok, warn, closed, error, total })),
    errors: payload.metrics
      .filter(m => m.status?.level === 'error')
      .map(m => ({ id: m.id, provider: m.provider, symbol: m.symbol, message: m.status?.message || '' }))
  };
  let lines = [];
  try {
    lines = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  lines.push(JSON.stringify(compact));
  lines = lines.slice(-500);
  await fs.writeFile(file, lines.join('\n') + '\n');
}

function summarize(items) {
  const summary = { total: items.length, ok: 0, warn: 0, closed: 0, error: 0 };
  for (const item of items) {
    const level = item.status?.level || 'error';
    if (level === 'ok') summary.ok += 1;
    else if (level === 'warn') summary.warn += 1;
    else if (level === 'closed') summary.closed += 1;
    else summary.error += 1;
  }
  return summary;
}

async function fetchFxLevels(results) {
  const targets = [
    { id: 'usdkrw', symbol: 'KRW=X', scale: 1, label: 'USD/KRW (원/달러)' },
    { id: 'eurkrw', symbol: 'EURKRW=X', scale: 1, label: 'EUR/KRW (원/유로)' },
    { id: 'jpykrw_100', symbol: 'JPYKRW=X', scale: 100, label: 'JPY/KRW x100 (원/100엔)' }
  ];
  const out = [];
  for (const target of targets) {
    const current = results.find(m => m.id === target.id);
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(target.symbol)}?range=5d&interval=1h`;
      const res = await fetch(url, { headers: { 'user-agent': 'stock-dashboard-mvp/0.1' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`Yahoo FX level HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const closes = (result?.indicators?.quote?.[0]?.close || [])
        .filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)))
        .map(v => Number(v) * target.scale);
      if (closes.length < 8) throw new Error(`not enough 5d FX closes (${closes.length})`);
      const support = Math.min(...closes);
      const resistance = Math.max(...closes);
      const average = closes.reduce((sum, v) => sum + v, 0) / closes.length;
      const currentValue = current?.value ?? null;
      const nearBufferPct = target.id === 'jpykrw_100' ? 0.08 : 0.05;
      const breakBufferPct = 0;
      const lowerBreak = currentValue !== null && currentValue < support;
      const upperBreak = currentValue !== null && currentValue > resistance;
      const nearSupport = currentValue !== null && !lowerBreak && currentValue >= support && ((currentValue - support) / support) * 100 <= nearBufferPct;
      const nearResistance = currentValue !== null && !upperBreak && currentValue <= resistance && ((resistance - currentValue) / resistance) * 100 <= nearBufferPct;
      out.push({
        id: target.id,
        label: target.label,
        current: currentValue,
        support,
        resistance,
        average,
        sampleCount: closes.length,
        source: 'Yahoo chart 5d/1h reference; current dashboard FX may use Naver/Hana primary',
        sourceSymbol: target.symbol,
        status: lowerBreak ? 'below_support' : upperBreak ? 'above_resistance' : nearSupport ? 'near_support' : nearResistance ? 'near_resistance' : 'inside_range',
        breakBufferPct,
        nearBufferPct,
        fetchedAt: new Date().toISOString()
      });
    } catch (err) {
      out.push({ id: target.id, label: target.label, current: current?.value ?? null, status: 'unavailable', message: err.message, fetchedAt: new Date().toISOString() });
    }
  }
  return out;
}

async function readKrxShortSellingDaily(generatedAt) {
  try {
    const payload = JSON.parse(await fs.readFile(path.join(root, 'data/krx-short-selling-daily.json'), 'utf8'));
    return {
      ...payload,
      embeddedAt: generatedAt
    };
  } catch (err) {
    return {
      id: 'krx_short_selling_daily',
      status: 'not_ready',
      generatedAt,
      message: 'KRX short-selling daily cache is not ready yet. Run npm run krx:short:refresh after KRX data sync.',
      items: []
    };
  }
}

async function fetchInvestorFlows() {
  const targets = [
    { id: 'kospi200_futures', label: 'KOSPI200 선물', paramKey: 'prodId', paramValue: 'KR___FUK2I' },
    { id: 'kospi200_options', label: 'KOSPI200 옵션', paramKey: 'prodId', paramValue: 'KR___OPK2I' },
    { id: 'kospi_cash', label: 'KOSPI 현물', paramKey: 'mktId', paramValue: 'STK' }
  ];
  const flows = [];
  for (const target of targets) {
    try {
      const body = new URLSearchParams({ bld: 'dbms/MDC/MAIN/MDCMAIN00103', [target.paramKey]: target.paramValue });
      const res = await fetch('https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd', {
        method: 'POST',
        headers: {
          'user-agent': 'Mozilla/5.0 stock-dashboard-mvp/0.1',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'referer': 'https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd',
          'x-requested-with': 'XMLHttpRequest'
        },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`KRX investor flow HTTP ${res.status}`);
      const json = await res.json();
      const rows = json.output || [];
      const foreign = rows.find(row => String(row.INVST_TP || '').includes('외국인'));
      if (!foreign) throw new Error('KRX investor flow missing foreign row');
      flows.push({
        id: target.id,
        label: target.label,
        tradeDate: foreign.TRD_DD || rows[0]?.TRD_DD || null,
        unit: '십억원',
        foreignBuy: parseKrxNumber(foreign.ACC_BID_TRDVAL),
        foreignSell: parseKrxNumber(foreign.ACC_ASK_TRDVAL),
        foreignNetBuy: parseKrxNumber(foreign.NETBID_TRDVAL),
        rows: rows.map(row => ({
          investor: row.INVST_TP,
          buy: parseKrxNumber(row.ACC_BID_TRDVAL),
          sell: parseKrxNumber(row.ACC_ASK_TRDVAL),
          netBuy: parseKrxNumber(row.NETBID_TRDVAL)
        })),
        source: 'KRX Data Marketplace main investor trend',
        sourceKey: target.paramValue,
        fetchedAt: new Date().toISOString(),
        currentDatetime: json.CURRENT_DATETIME || null,
        status: 'ok'
      });
    } catch (err) {
      flows.push({ id: target.id, label: target.label, status: 'error', message: err.message, fetchedAt: new Date().toISOString() });
    }
  }
  return flows;
}

async function fetchKospi200PutCallRatio(generatedAt) {
  const krxEod = await readKrxEodPutCallRatio(generatedAt);
  if (krxEod) return krxEod;

  const activeProbe = await readActivePutCallRatioProbe(generatedAt);
  if (activeProbe) return activeProbe;

  const base = {
    id: 'kospi200_options_pcr',
    label: 'KOSPI200 옵션 PCR',
    market: 'KOSPI200 options',
    basis: 'kis_display_board_callput_top100',
    source: 'KIS 국내옵션전광판_콜풋 API; output1/output2 각 100행 집계',
    sourcePath: '/uapi/domestic-futureoption/v1/quotations/display-board-callput',
    generatedAt,
    fetchedAt: new Date().toISOString()
  };
  try {
    const listQuery = new URLSearchParams({
      FID_COND_SCR_DIV_CODE: '509',
      FID_COND_MRKT_DIV_CODE: '',
      FID_COND_MRKT_CLS_CODE: ''
    }).toString();
    const listRes = await requestKisPcrWithRetry({
      path: '/uapi/domestic-futureoption/v1/quotations/display-board-option-list',
      trId: 'FHPIO056104C0',
      query: listQuery
    }, { timeoutMs });
    const monthRows = Array.isArray(listRes.json.output) ? listRes.json.output : [];
    const frontMonth = monthRows.find(row => row?.mtrt_yymm) || null;
    if (!frontMonth) throw new Error(`KIS option month list empty: ${listRes.json.msg1 || 'no output'}`);

    const callputQuery = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'O',
      FID_COND_SCR_DIV_CODE: '20503',
      FID_MRKT_CLS_CODE: 'CO',
      FID_MTRT_CNT: String(frontMonth.mtrt_yymm),
      FID_MRKT_CLS_CODE1: 'PO',
      FID_COND_MRKT_CLS_CODE: ''
    }).toString();
    await sleep(1100);
    const callputRes = await requestKisPcrWithRetry({
      path: '/uapi/domestic-futureoption/v1/quotations/display-board-callput',
      trId: 'FHPIF05030100',
      query: callputQuery
    }, { timeoutMs: Math.max(timeoutMs, 15000) });
    const calls = Array.isArray(callputRes.json.output1) ? callputRes.json.output1 : [];
    const puts = Array.isArray(callputRes.json.output2) ? callputRes.json.output2 : [];
    if (!calls.length || !puts.length) throw new Error(`KIS callput output empty: ${callputRes.json.msg1 || 'no output'}`);

    const call = summarizeOptionSide(calls);
    const put = summarizeOptionSide(puts);
    const volumePcr = ratioOrNull(put.volume, call.volume);
    const amountPcr = ratioOrNull(put.amount, call.amount);
    const openInterestPcr = ratioOrNull(put.openInterest, call.openInterest);
    const limitedCoverage = calls.length >= 100 || puts.length >= 100;
    const suspiciousCoverage = call.volume > 0 && put.volume === 0;
    const usableForSignal = !limitedCoverage && !suspiciousCoverage;
    const history = usableForSignal
      ? await updatePutCallRatioHistory({ date: formatKstDate(new Date(generatedAt)), generatedAt, volumePcr, amountPcr, openInterestPcr })
      : [];
    const ma3 = movingAverage(history, 'volumePcr', 3);
    const ma5 = movingAverage(history, 'volumePcr', 5);
    return {
      ...base,
      status: usableForSignal ? 'ok' : 'limited',
      message: usableForSignal ? null : 'KIS 전광판 반환 범위가 제한되어 PCR 신호로 사용 보류',
      expiryMonth: String(frontMonth.mtrt_yymm),
      expiryMonthCode: frontMonth.mtrt_yymm_code || null,
      call,
      put,
      volumePcr,
      amountPcr,
      openInterestPcr,
      volumePcrX100: volumePcr === null ? null : volumePcr * 100,
      amountPcrX100: amountPcr === null ? null : amountPcr * 100,
      openInterestPcrX100: openInterestPcr === null ? null : openInterestPcr * 100,
      ma3,
      ma5,
      labelState: usableForSignal ? classifyPutCallRatio(ma3 ?? volumePcr) : { key: 'limited', label: '검증 대기', impact: 'Watch', guidance: '콜/풋 100행 제한 때문에 공식 PCR 대체값으로 쓰지 않음' },
      historySampleCount: history.length,
      usableForSignal,
      limitedCoverage,
      suspiciousCoverage,
      warnings: [
        'KIS 전광판 API는 콜/풋 각각 최대 100행만 반환하므로 KRX 공식 P/C Ratio와 차이가 날 수 있음',
        '일중 자동 모니터링용 보조지표로 사용하고, 공식 수치는 KRX/HTS와 교차확인 권장'
      ],
      fetchedAt: new Date().toISOString()
    };
  } catch (err) {
    return { ...base, status: 'error', message: err.name === 'AbortError' ? 'KIS PCR timeout' : err.message, fetchedAt: new Date().toISOString() };
  }
}

async function readKrxEodPutCallRatio(generatedAt) {
  const file = path.join(root, 'data/kospi200-pcr-krx-eod.json');
  const maxAgeSec = Number(process.env.KRX_PCR_EOD_CACHE_MAX_AGE_SEC || 7 * 24 * 60 * 60);
  try {
    const payload = JSON.parse(await fs.readFile(file, 'utf8'));
    if (payload?.status !== 'ok' || payload.usableForVerification !== true) return null;
    const cacheTime = new Date(payload.generatedAt || 0).getTime();
    if (!Number.isFinite(cacheTime)) return null;
    const ageSec = Math.max(0, (new Date(generatedAt).getTime() - cacheTime) / 1000);
    if (ageSec > maxAgeSec) return null;
    const volumePcr = numberOrNull(payload.volumePcr);
    const amountPcr = numberOrNull(payload.amountPcr);
    const openInterestPcr = numberOrNull(payload.openInterestPcr);
    const history = await updatePutCallRatioHistory({
      date: compactKrxDateToIso(payload.basDd) || formatKstDate(new Date(generatedAt)),
      generatedAt: payload.generatedAt || generatedAt,
      volumePcr,
      amountPcr,
      openInterestPcr
    });
    const ma3 = movingAverage(history, 'volumePcr', 3);
    const ma5 = movingAverage(history, 'volumePcr', 5);
    const tradeDateIso = compactKrxDateToIso(payload.basDd) || formatKstDate(new Date(generatedAt));
    const comparison = buildPutCallRatioComparison(history, tradeDateIso);
    const expiryContext = buildKoreaOptionExpiryContext(tradeDateIso);
    return {
      id: 'kospi200_options_pcr',
      label: 'KOSPI200 옵션 PCR',
      market: 'KOSPI200 options',
      basis: `KRX 공식 EOD ${compactKrxDateToIso(payload.basDd) || payload.basDd || ''}`.trim(),
      source: payload.source || 'KRX OpenAPI options daily trading information',
      sourcePath: payload.sourcePath || '/svc/apis/drv/opt_bydd_trd',
      status: 'ok',
      quality: 'OFFICIAL_EOD',
      message: null,
      generatedAt,
      fetchedAt: new Date().toISOString(),
      cacheGeneratedAt: payload.generatedAt || null,
      ageSec,
      tradeDate: compactKrxDateToIso(payload.basDd) || payload.basDd || null,
      expiryMonth: '전체 만기',
      universe: payload.universe || null,
      call: payload.call || null,
      put: payload.put || null,
      volumePcr,
      amountPcr,
      openInterestPcr,
      volumePcrX100: volumePcr === null ? null : volumePcr * 100,
      amountPcrX100: amountPcr === null ? null : amountPcr * 100,
      openInterestPcrX100: openInterestPcr === null ? null : openInterestPcr * 100,
      ma3,
      ma5,
      comparison,
      expiryContext,
      labelState: classifyPutCallRatio(volumePcr),
      historySampleCount: history.length,
      usableForSignal: true,
      limitedCoverage: false,
      suspiciousCoverage: false,
      warnings: [
        'KRX OpenAPI 공식 일별매매정보 기반 EOD 값이므로 장중 실시간 PCR은 아님',
        '당일 장중에는 직전 거래일 EOD 값으로 표시될 수 있음'
      ]
    };
  } catch {
    return null;
  }
}

async function readActivePutCallRatioProbe(generatedAt) {
  const file = path.join(root, 'data/kospi200-pcr-fullchain-probe.json');
  const maxAgeSec = Number(process.env.PCR_ACTIVE_CACHE_MAX_AGE_SEC || 8 * 60 * 60);
  try {
    const probe = JSON.parse(await fs.readFile(file, 'utf8'));
    if (probe?.mode !== 'active') return null;
    const probeTime = new Date(probe.generatedAt || probe.startedAt || 0).getTime();
    if (!Number.isFinite(probeTime)) return null;
    const ageSec = Math.max(0, (new Date(generatedAt).getTime() - probeTime) / 1000);
    if (ageSec > maxAgeSec) return null;
    const contractsRequested = numberOrNull(probe.coverage?.contractsRequested) ?? 0;
    const contractsOk = numberOrNull(probe.coverage?.contractsOk) ?? 0;
    const coveragePct = numberOrNull(probe.coverage?.coveragePct);
    const expiry = Array.isArray(probe.selection?.selectedExpiries) ? probe.selection.selectedExpiries[0] : null;
    const windowLabel = probe.selection?.expiryDetails?.[0]
      ? `ATM ${probe.selection.expiryDetails[0].atmStrike ?? '확인'} ±${probe.selection.strikesAround ?? ''}`.trim()
      : 'ATM window';
    return {
      id: 'kospi200_options_pcr',
      label: 'KOSPI200 옵션 PCR',
      market: 'KOSPI200 options',
      basis: 'kis_active_atm_window_observation',
      source: 'KIS 개별 옵션 inquire-price active universe cache',
      sourcePath: '/uapi/domestic-futureoption/v1/quotations/inquire-price',
      status: 'observing',
      quality: 'DIAGNOSTIC_SAMPLE_ONLY',
      message: 'ATM 주변 일부 계약 표본이라 대표 PCR/포지션으로 표시 보류 · 공식/HTS 누적 소스 확정 필요',
      generatedAt,
      fetchedAt: new Date().toISOString(),
      cacheGeneratedAt: probe.generatedAt || null,
      ageSec,
      expiryMonth: expiry,
      selection: probe.selection || null,
      universe: probe.universe || null,
      requestPolicy: probe.requestPolicy || null,
      call: probe.call || null,
      put: probe.put || null,
      volumePcr: numberOrNull(probe.volumePcr),
      amountPcr: numberOrNull(probe.amountPcr),
      openInterestPcr: numberOrNull(probe.openInterestPcr),
      volumePcrX100: numberOrNull(probe.volumePcrX100),
      amountPcrX100: numberOrNull(probe.amountPcr) === null ? null : numberOrNull(probe.amountPcr) * 100,
      openInterestPcrX100: numberOrNull(probe.openInterestPcr) === null ? null : numberOrNull(probe.openInterestPcr) * 100,
      coverage: {
        contractsRequested,
        contractsOk,
        contractsError: numberOrNull(probe.coverage?.contractsError) ?? Math.max(0, contractsRequested - contractsOk),
        coveragePct,
        universeCoveragePct: numberOrNull(probe.coverage?.universeCoveragePct)
      },
      ma3: null,
      ma5: null,
      labelState: {
        key: 'observing',
        label: '검증 중',
        impact: 'Watch',
        guidance: `${expiry || '최근월물'} ${windowLabel} 기준 관찰값. 공식 KRX EOD와 대조 전까지 매매 신호로 쓰지 않음.`
      },
      historySampleCount: 0,
      usableForSignal: false,
      limitedCoverage: true,
      suspiciousCoverage: false,
      warnings: [
        'KIS active universe는 전체 5,224개 표준 옵션 중 ATM 주변 일부 계약만 조회한 관찰값임',
        'KRX OpenAPI EOD opt_bydd_trd와 여러 거래일 reconciliation 전까지 LIVE/VERIFIED 신호로 승격하지 않음'
      ]
    };
  } catch {
    return null;
  }
}

function summarizeOptionSide(rows) {
  return rows.reduce((acc, row) => {
    acc.rows += 1;
    acc.volume += numberOrNull(row.acml_vol) ?? 0;
    acc.amount += numberOrNull(row.acml_tr_pbmn) ?? 0;
    acc.openInterest += numberOrNull(row.hts_otst_stpl_qty) ?? 0;
    acc.openInterestChange += numberOrNull(row.otst_stpl_qty_icdc) ?? 0;
    return acc;
  }, { rows: 0, volume: 0, amount: 0, openInterest: 0, openInterestChange: 0 });
}

function ratioOrNull(numerator, denominator) {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined || Number(denominator) === 0) return null;
  const ratio = Number(numerator) / Number(denominator);
  return Number.isFinite(ratio) ? ratio : null;
}

async function updatePutCallRatioHistory(row) {
  const file = path.join(root, 'data/put-call-ratio-history.json');
  let history = [];
  try {
    history = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch {}
  const next = history.filter(item => item.date !== row.date);
  next.push(row);
  next.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const pruned = next.slice(-90);
  await writeJsonAtomic(file, pruned);
  return pruned;
}

function movingAverage(rows, key, count) {
  const values = rows.slice(-count).map(row => numberOrNull(row[key])).filter(v => v !== null);
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function buildPutCallRatioComparison(history, currentDate) {
  const rows = (Array.isArray(history) ? history : [])
    .filter(row => row?.date && row.date <= currentDate)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const current = rows.find(row => row.date === currentDate) || rows.at(-1) || null;
  if (!current) return null;
  const priorRows = rows.filter(row => row.date < current.date);
  const previous = priorRows.at(-1) || null;
  const avg5Rows = rows.slice(-5);
  const volumeAvg5 = movingAverage(avg5Rows, 'volumePcr', 5);
  const openInterestAvg5 = movingAverage(avg5Rows, 'openInterestPcr', 5);
  return {
    currentDate: current.date,
    previousDate: previous?.date || null,
    volumePcrDelta: previous ? diffOrNull(current.volumePcr, previous.volumePcr) : null,
    volumePcrDeltaX100: previous ? diffOrNull(scale100(current.volumePcr), scale100(previous.volumePcr)) : null,
    volumePcrVsAvg5Pct: pctDistanceOrNull(current.volumePcr, volumeAvg5),
    openInterestPcrDelta: previous ? diffOrNull(current.openInterestPcr, previous.openInterestPcr) : null,
    openInterestPcrDeltaX100: previous ? diffOrNull(scale100(current.openInterestPcr), scale100(previous.openInterestPcr)) : null,
    openInterestPcrVsAvg5Pct: pctDistanceOrNull(current.openInterestPcr, openInterestAvg5),
    amountPcrDelta: previous ? diffOrNull(current.amountPcr, previous.amountPcr) : null,
    amountPcrDeltaX100: previous ? diffOrNull(scale100(current.amountPcr), scale100(previous.amountPcr)) : null,
    sampleCount: rows.length
  };
}

function scale100(value) {
  const n = numberOrNull(value);
  return n === null ? null : n * 100;
}

function diffOrNull(left, right) {
  const a = numberOrNull(left);
  const b = numberOrNull(right);
  if (a === null || b === null) return null;
  const diff = a - b;
  return Number.isFinite(diff) ? diff : null;
}

function pctDistanceOrNull(value, base) {
  const v = numberOrNull(value);
  const b = numberOrNull(base);
  if (v === null || b === null || b === 0) return null;
  const pct = ((v - b) / Math.abs(b)) * 100;
  return Number.isFinite(pct) ? pct : null;
}

function buildKoreaOptionExpiryContext(tradeDateIso) {
  const currentDate = /^\d{4}-\d{2}-\d{2}$/.test(String(tradeDateIso || '')) ? tradeDateIso : formatKstDate(new Date());
  const current = new Date(`${currentDate}T00:00:00+09:00`);
  if (Number.isNaN(current.getTime())) return null;
  let expiry = secondThursday(current.getFullYear(), current.getMonth());
  if (current.getTime() > expiry.getTime()) expiry = secondThursday(current.getFullYear(), current.getMonth() + 1);
  const daysToExpiry = Math.round((expiry.getTime() - current.getTime()) / (24 * 60 * 60 * 1000));
  const expiryDate = formatKstDate(expiry);
  const month = expiry.getMonth() + 1;
  return {
    tradeDate: currentDate,
    expiryDate,
    daysToExpiry,
    label: daysToExpiry === 0 ? '만기일' : `D-${daysToExpiry}`,
    isQuarterlyExpiry: [3, 6, 9, 12].includes(month),
    phase: daysToExpiry <= 1 ? 'expiry_day_window' : daysToExpiry <= 5 ? 'expiry_week' : 'position_building'
  };
}

function secondThursday(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1, 0));
  const day = first.getUTCDay();
  const firstThursdayDate = 1 + ((4 - day + 7) % 7);
  return new Date(Date.UTC(year, monthIndex, firstThursdayDate + 7, 0));
}

function classifyPutCallRatio(value) {
  if (value === null || value === undefined) return { key: 'unknown', label: '확인 중', impact: 'Watch', guidance: 'PCR 산출 대기' };
  if (value < 0.6) return { key: 'call_extreme', label: '콜 우세 과열', impact: 'Watch', guidance: '상방 심리는 강하지만 낙관 과열 경계' };
  if (value < 0.85) return { key: 'call_bias', label: '콜 우세', impact: 'Watch', guidance: '비교적 risk-on / 상방 심리 우세' };
  if (value <= 1.15) return { key: 'neutral', label: '중립', impact: 'Info', guidance: 'KOSPI200 옵션 심리는 정상 범위' };
  if (value <= 1.5) return { key: 'put_bias', label: '하방 경계', impact: 'Watch', guidance: '풋 헤지 증가 / 조정 경계' };
  if (value <= 2.0) return { key: 'risk_off', label: '강한 위험회피', impact: 'High', guidance: '하방 압력과 단기 과매도 가능성 동시 관찰' };
  return { key: 'panic_extreme', label: '공포 극단', impact: 'High', guidance: '추격 매도보다 반전 여부와 VKOSPI 동행 확인' };
}

async function buildOptionPositionChangeSignal(pcr, results, generatedAt) {
  if (!pcr || pcr.usableForSignal !== true || !['ok', 'observing'].includes(pcr.status)) return null;
  const view = classifyOptionPositionForSignal(pcr, results);
  if (!view?.key || view.key === 'unknown') return null;
  const file = path.join(root, 'data/option-position-state.json');
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  const next = { key: view.key, label: view.label, interpretation: view.interpretation, updatedAt: generatedAt };
  await writeJsonAtomic(file, next);
  if (prev?.key === view.key) return null;
  if (!prev?.key) return null;
  return {
    id: `option-position-${view.key}`,
    type: 'option_position_status_change',
    title: `KOSPI200 옵션 해석 변화 — ${view.label}`,
    impact: view.impact,
    relatedGroups: ['KR', 'KIS', 'Options'],
    summary: `${view.interpretation} 거래량 PCR ${fmt(pcr.volumePcr, 2)}, 포지션 PCR ${fmt(pcr.openInterestPcr, 2)}. 현재는 KIS active universe 관찰값이므로 공식 KRX EOD 검증 전까지 참고 신호로만 사용.`,
    source: pcr.source || 'KIS active PCR cache',
    dataTimestamp: pcr.cacheGeneratedAt || pcr.fetchedAt || generatedAt,
    status: view.key,
    occurredAt: generatedAt
  };
}

function classifyOptionPositionForSignal(pcr, results = []) {
  const volume = Number(pcr?.volumePcr);
  const oi = Number(pcr?.openInterestPcr);
  if (!Number.isFinite(volume) && !Number.isFinite(oi)) return { key: 'unknown' };
  const metricById = new Map(results.map(metric => [metric.id, metric]));
  const kospi200 = metricById.get('kospi200') || metricById.get('kospi200_futures_kis');
  const priceChangePct = Number(kospi200?.changePct);
  const volBand = optionPcrBand(volume);
  const oiBand = optionPcrBand(oi);
  let key = `vol_${volBand.key}_oi_${oiBand.key}`;
  let label = `${volBand.label} / ${oiBand.label}`;
  let interpretation = `거래량은 ${volBand.phrase}, 남아 있는 포지션은 ${oiBand.phrase}.`;
  let impact = volBand.impact === 'High' || oiBand.impact === 'High' ? 'High' : 'Watch';
  if (Number.isFinite(priceChangePct)) {
    if (priceChangePct > 0.15 && volume < 0.85) {
      key = `up_confirm_${oiBand.key}`;
      label = '상승 흐름 확인';
      interpretation = `KOSPI200은 오르고 옵션 거래도 콜 쪽이 상대적으로 활발해 상승 흐름을 확인하는 모습.`;
      impact = 'Watch';
    } else if (priceChangePct < -0.15 && volume > 1.15) {
      key = `down_confirm_${oiBand.key}`;
      label = '하방 경계 강화';
      interpretation = `KOSPI200이 밀리는 가운데 풋 거래가 늘어 하방 헤지/위험회피가 커지는 모습.`;
      impact = 'High';
    } else if (priceChangePct > 0.15 && volume > 1.15) {
      key = `up_with_hedge_${oiBand.key}`;
      label = '상승 중 헤지 증가';
      interpretation = `KOSPI200은 오르지만 옵션 쪽에서는 풋 거래가 늘어 상승 중 헤지가 붙는 모습.`;
      impact = 'Watch';
    } else if (priceChangePct < -0.15 && volume < 0.85) {
      key = `down_pressure_easing_${oiBand.key}`;
      label = '하락 압력 약화 가능';
      interpretation = `KOSPI200은 밀리지만 풋 거래 압력은 약해져 하락 압력이 둔화될 가능성을 관찰.`;
      impact = 'Watch';
    }
  }
  if (Number.isFinite(oi) && oi >= 1.5) {
    interpretation += ` 다만 미결제약정은 풋 쪽으로 강하게 기울어 남아 있는 헤지 포지션이 많은 편.`;
    if (impact !== 'High') impact = 'Watch';
  }
  return { key, label, interpretation, impact };
}

function optionPcrBand(value) {
  if (!Number.isFinite(value)) return { key: 'unknown', label: '확인 중', phrase: '확인 중', impact: 'Watch' };
  if (value < 0.6) return { key: 'call_extreme', label: '콜 과열', phrase: '콜 쪽으로 과하게 몰림', impact: 'Watch' };
  if (value < 0.85) return { key: 'call_bias', label: '콜 우세', phrase: '콜 쪽이 더 활발함', impact: 'Watch' };
  if (value <= 1.15) return { key: 'neutral', label: '중립', phrase: '한쪽으로 크게 쏠리지 않음', impact: 'Watch' };
  if (value <= 1.5) return { key: 'put_bias', label: '풋 우세', phrase: '풋 쪽으로 기움', impact: 'Watch' };
  if (value <= 2.0) return { key: 'risk_off', label: '강한 위험회피', phrase: '풋 쪽 포지션이 강함', impact: 'High' };
  return { key: 'panic_extreme', label: '공포 극단', phrase: '풋 쏠림이 극단적임', impact: 'High' };
}

async function requestKisPcrWithRetry(request, { timeoutMs = 15000, attempts = 3, baseDelayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestKis(request, process.env, { timeoutMs });
    } catch (err) {
      lastErr = err;
      const message = err.name === 'AbortError' ? 'KIS PCR timeout' : err.message || '';
      if (attempt >= attempts || !/초당 거래건수|재 조회|timeout|aborted|KIS HTTP 500/i.test(message)) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchMarketVolumes(results, generatedAt) {
  const kospi = await fetchKospiSpotVolume(generatedAt);
  const futures = await buildKospi200FuturesVolume(results, generatedAt);
  const items = [kospi, futures].filter(Boolean);
  const snapshots = await updateVolumeSnapshots(items, generatedAt);
  return {
    generatedAt,
    checkpointsKst: ['10:00', '12:00', '15:30', '16:35'],
    items: items.map(item => ({ ...item, snapshots: snapshots[item.id] || [] }))
  };
}

async function fetchKospiSpotVolume(generatedAt) {
  const endDate = formatKstDateCompact(new Date(generatedAt));
  const startDate = formatKstDateCompact(new Date(new Date(generatedAt).getTime() - 190 * 24 * 60 * 60 * 1000));
  const url = `https://api.stock.naver.com/chart/domestic/index/KOSPI/day?startDateTime=${startDate}&endDateTime=${endDate}`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 stock-dashboard-mvp/0.1', accept: 'application/json,text/plain,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Naver KOSPI volume HTTP ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json) ? json
      .map(row => ({ date: String(row.localDate || ''), volume: numberOrNull(row.accumulatedTradingVolume) }))
      .filter(row => row.date && row.volume !== null)
      .sort((a, b) => a.date.localeCompare(b.date)) : [];
    if (!rows.length) throw new Error('Naver KOSPI volume has no usable rows');
    const current = rows[rows.length - 1];
    const max = rows.reduce((best, row) => row.volume > best.volume ? row : best, rows[0]);
    const avg = rows.reduce((sum, row) => sum + row.volume, 0) / rows.length;
    return buildVolumeItem({
      id: 'kospi_spot_volume',
      label: 'KOSPI 현물 거래량',
      market: '현물',
      currentVolume: current.volume,
      currentDate: current.date,
      sixMonthMaxVolume: max.volume,
      sixMonthMaxDate: max.date,
      sixMonthAverageVolume: avg,
      sampleCount: rows.length,
      source: 'Naver domestic index day chart',
      sourceUrl: url,
      basis: 'six_month_history',
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return {
      id: 'kospi_spot_volume',
      label: 'KOSPI 현물 거래량',
      market: '현물',
      currentVolume: null,
      status: 'error',
      message: err.name === 'AbortError' ? 'Naver KOSPI volume timeout' : err.message,
      source: 'Naver domestic index day chart',
      sourceUrl: url,
      fetchedAt: new Date().toISOString()
    };
  }
}

async function buildKospi200FuturesVolume(results, generatedAt) {
  const metric = results.find(item => item.id === 'kospi200_futures_kis');
  const currentVolume = numberOrNull(metric?.volume);
  const kisHistory = metric?.symbol ? await fetchKisFuturesDailyVolume(metric.symbol, generatedAt) : null;
  if (currentVolume !== null && kisHistory?.rows?.length) {
    const rows = kisHistory.rows;
    const currentDate = formatKstDateCompact(new Date(generatedAt));
    const currentRow = rows.find(row => row.date === currentDate) || rows[0];
    const adjustedRows = rows.map(row => row.date === currentRow?.date ? { ...row, volume: currentVolume } : row);
    const max = adjustedRows.reduce((best, row) => row.volume > best.volume ? row : best, adjustedRows[0]);
    const avg = adjustedRows.reduce((sum, row) => sum + row.volume, 0) / adjustedRows.length;
    return buildVolumeItem({
      id: 'kospi200_futures_volume',
      label: 'KOSPI200 주간선물 거래량',
      market: '선물',
      currentVolume,
      currentDate,
      sixMonthMaxVolume: max.volume,
      sixMonthMaxDate: max.date,
      sixMonthAverageVolume: avg,
      sampleCount: adjustedRows.length,
      source: 'KIS 선물옵션기간별시세 일봉 acml_vol',
      sourceUrl: kisHistory.sourceUrl,
      basis: 'kis_100_trading_days',
      periodLabel: `KIS ${adjustedRows.length}거래일`,
      fetchedAt: new Date().toISOString()
    });
  }

  const history = await readVolumeSnapshotFile();
  const cutoff = new Date(new Date(generatedAt).getTime() - 190 * 24 * 60 * 60 * 1000).toISOString();
  const observed = Object.values(history.days || {}).flatMap(day => Array.isArray(day.kospi200_futures_volume) ? day.kospi200_futures_volume : [])
    .filter(row => row?.capturedAt >= cutoff && numberOrNull(row.volume) !== null)
    .map(row => ({ date: String(row.date || '').replace(/-/g, ''), volume: numberOrNull(row.volume), capturedAt: row.capturedAt }));
  if (currentVolume !== null) observed.push({ date: formatKstDateCompact(new Date(generatedAt)), volume: currentVolume, capturedAt: generatedAt });
  const max = observed.length ? observed.reduce((best, row) => row.volume > best.volume ? row : best, observed[0]) : null;
  const avg = observed.length ? observed.reduce((sum, row) => sum + row.volume, 0) / observed.length : null;

  if (!metric || currentVolume === null) {
    return {
      id: 'kospi200_futures_volume',
      label: 'KOSPI200 주간선물 거래량',
      market: '선물',
      currentVolume: null,
      status: 'warn',
      message: metric?.status?.message || 'KIS futures current volume unavailable',
      source: 'KIS display-board-futures acml_vol',
      sourceUrl: metric?.sourceUrl || null,
      basis: 'kis_current_only',
      fetchedAt: new Date().toISOString()
    };
  }

  return buildVolumeItem({
    id: 'kospi200_futures_volume',
    label: 'KOSPI200 주간선물 거래량',
    market: '선물',
    currentVolume,
    currentDate: formatKstDateCompact(new Date(generatedAt)),
    sixMonthMaxVolume: max?.volume ?? currentVolume,
    sixMonthMaxDate: max?.date || formatKstDateCompact(new Date(generatedAt)),
    sixMonthAverageVolume: avg,
    sampleCount: observed.length,
    source: 'KIS display-board-futures acml_vol; max/avg is local observed history until an official 6-month futures history source is confirmed',
    sourceUrl: metric.sourceUrl || null,
    basis: observed.length >= 20 ? 'local_observed_history' : 'local_observed_warming_up',
    fetchedAt: new Date().toISOString()
  });
}

async function fetchKisFuturesDailyVolume(symbol, generatedAt) {
  try {
    const endDate = formatKstDateCompact(new Date(generatedAt));
    const startDate = formatKstDateCompact(new Date(new Date(generatedAt).getTime() - 190 * 24 * 60 * 60 * 1000));
    const query = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'F',
      FID_INPUT_ISCD: symbol,
      FID_INPUT_DATE_1: startDate,
      FID_INPUT_DATE_2: endDate,
      FID_PERIOD_DIV_CODE: 'D'
    }).toString();
    const { json, url } = await requestKis({
      path: '/uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice',
      trId: 'FHKIF03020100',
      query
    }, process.env, { timeoutMs });
    const rows = Array.isArray(json.output2) ? json.output2
      .map(row => ({ date: String(row.stck_bsop_date || ''), volume: numberOrNull(row.acml_vol) }))
      .filter(row => row.date && row.volume !== null)
      .sort((a, b) => b.date.localeCompare(a.date)) : [];
    if (!rows.length) return { rows: [], sourceUrl: url, message: 'KIS futures daily history empty' };
    return { rows, sourceUrl: url };
  } catch (err) {
    return { rows: [], sourceUrl: null, message: err.name === 'AbortError' ? 'KIS futures daily history timeout' : err.message };
  }
}

function buildVolumeItem(input) {
  if (input.basis === 'local_observed_warming_up') {
    return {
      ...input,
      maxPct: null,
      avgPct: null,
      status: 'warn',
      intensity: '축적중',
      message: input.message || '선물 6개월 최대 거래량 기준은 공식 히스토리 소스 확정 전이라 로컬 관측치를 축적 중입니다.'
    };
  }
  const maxPct = input.currentVolume !== null && input.sixMonthMaxVolume ? (input.currentVolume / input.sixMonthMaxVolume) * 100 : null;
  const avgPct = input.currentVolume !== null && input.sixMonthAverageVolume ? (input.currentVolume / input.sixMonthAverageVolume) * 100 : null;
  const intensity = volumeIntensity(maxPct);
  return {
    ...input,
    maxPct,
    avgPct,
    status: input.status || intensity.status,
    intensity: intensity.label,
    message: input.message || intensity.message
  };
}

function volumeIntensity(maxPct) {
  if (maxPct === null || maxPct === undefined || !Number.isFinite(Number(maxPct))) return { status: 'warn', label: '산출대기', message: '거래량 기준값을 아직 계산하지 못했습니다.' };
  if (maxPct >= 85) return { status: 'high', label: '과열/이벤트성', message: '최근 최대 거래량에 근접한 강한 거래량입니다.' };
  if (maxPct >= 60) return { status: 'active', label: '활발', message: '최근 6개월 최대치 대비 거래가 활발합니다.' };
  if (maxPct >= 30) return { status: 'normal', label: '보통', message: '최근 6개월 최대치 대비 보통 수준입니다.' };
  return { status: 'quiet', label: '한산', message: '최근 6개월 최대치 대비 거래량은 아직 낮은 편입니다.' };
}

async function updateVolumeSnapshots(items, generatedAt) {
  const file = path.join(root, 'data/volume-snapshots.json');
  const state = await readVolumeSnapshotFile();
  state.days ||= {};
  const date = formatKstDate(new Date(generatedAt));
  state.days[date] ||= {};
  const checkpoints = ['10:00', '12:00', '15:30', '16:35'];
  const currentMinutes = kstMinutes(new Date(generatedAt));
  for (const item of items) {
    if (numberOrNull(item.currentVolume) === null) continue;
    state.days[date][item.id] ||= [];
    const rows = state.days[date][item.id];
    for (const checkpoint of checkpoints) {
      const target = checkpointToMinutes(checkpoint);
      if (currentMinutes < target || currentMinutes > target + 10) continue;
      if (rows.some(row => row.checkpointKst === checkpoint)) continue;
      rows.push({ checkpointKst: checkpoint, date, volume: item.currentVolume, maxPct: item.maxPct ?? null, avgPct: item.avgPct ?? null, intensity: item.intensity || null, capturedAt: generatedAt });
    }
  }
  pruneVolumeSnapshotState(state, generatedAt);
  state.updatedAt = generatedAt;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, state);
  return Object.fromEntries(items.map(item => [item.id, state.days[date]?.[item.id] || []]));
}

async function readVolumeSnapshotFile() {
  try {
    return JSON.parse(await fs.readFile(path.join(root, 'data/volume-snapshots.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { days: {} };
    return { days: {}, readError: err.message };
  }
}

function pruneVolumeSnapshotState(state, generatedAt) {
  const cutoff = formatKstDate(new Date(new Date(generatedAt).getTime() - 210 * 24 * 60 * 60 * 1000));
  for (const date of Object.keys(state.days || {})) {
    if (date < cutoff) delete state.days[date];
  }
}

function kstMinutes(date) {
  const p = partsInTimeZone(date, 'Asia/Seoul');
  return p.hour * 60 + p.minute;
}

function checkpointToMinutes(checkpoint) {
  const [hour, minute] = String(checkpoint).split(':').map(Number);
  return hour * 60 + minute;
}

function parseKrxNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchIntradayShapes() {
  const targets = [{ id: 'sox', symbol: '^SOX', label: 'SOX' }];
  const shapes = [];
  for (const target of targets) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(target.symbol)}?range=1d&interval=5m`;
      const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'stock-dashboard-mvp/0.1' } });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`Yahoo shape HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const meta = result?.meta || {};
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const lows = result?.indicators?.quote?.[0]?.low || [];
      const timestamps = result?.timestamp || [];
      const previousClose = Number(meta.previousClose ?? meta.chartPreviousClose);
      const lastIndex = findLastNumericIndex(closes);
      if (!Number.isFinite(previousClose) || lastIndex < 0) throw new Error('Yahoo shape missing previousClose/close');
      const last = Number(closes[lastIndex]);
      const lowIndex = findExtremeIndex(lows, 'min');
      const low = lowIndex >= 0 ? Number(lows[lowIndex]) : null;
      const closePct = ((last - previousClose) / previousClose) * 100;
      const lowPct = low !== null ? ((low - previousClose) / previousClose) * 100 : null;
      shapes.push({
        id: target.id,
        label: target.label,
        symbol: target.symbol,
        previousClose,
        last,
        low,
        closePct,
        lowPct,
        recoveredPct: lowPct !== null ? closePct - lowPct : null,
        lowTimestamp: lowIndex >= 0 && timestamps[lowIndex] ? new Date(timestamps[lowIndex] * 1000).toISOString() : null,
        lastTimestamp: timestamps[lastIndex] ? new Date(timestamps[lastIndex] * 1000).toISOString() : null,
        source: 'Yahoo chart 1d/5m intraday shape'
      });
    } catch (err) {
      shapes.push({ id: target.id, label: target.label, symbol: target.symbol, status: 'error', message: err.message });
    }
  }
  return shapes;
}

function findLastNumericIndex(values = []) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(Number(values[i]))) return i;
  }
  return -1;
}

function findExtremeIndex(values = [], mode = 'min') {
  let bestIndex = -1;
  let bestValue = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) continue;
    if (bestIndex < 0 || (mode === 'min' ? value < bestValue : value > bestValue)) {
      bestIndex = i;
      bestValue = value;
    }
  }
  return bestIndex;
}

function buildMarketSignals(results, fxLevels = [], investorFlows = [], generatedAt = new Date().toISOString(), intradayShapes = []) {
  const signals = [];
  const withOccurrenceTime = signal => ({ occurredAt: generatedAt, ...signal });
  const metricById = new Map(results.map(metric => [metric.id, metric]));

  signals.push(...buildKoreaMarketSafetySignals(metricById, generatedAt));
  const kospiDistanceSignal = buildKospiDistanceSignal(metricById.get('kospi_distance_60'), generatedAt);
  if (kospiDistanceSignal) signals.push(kospiDistanceSignal);
  const kospiVolatilitySignal = buildKospiVolatilityLevelSignal(metricById.get('ksvkospi'), generatedAt);
  if (kospiVolatilitySignal) signals.push(kospiVolatilitySignal);
  const highYieldSpreadSignal = buildHighYieldSpreadLevelSignal(metricById.get('us_high_yield_spread'), generatedAt);
  if (highYieldSpreadSignal) signals.push(highYieldSpreadSignal);

  for (const level of fxLevels) {
    if (!['below_support', 'above_resistance', 'near_support', 'near_resistance'].includes(level.status)) continue;
    const isBreak = level.status === 'below_support' || level.status === 'above_resistance';
    const isUsdKrw = level.id === 'usdkrw';
    const isKrwPair = ['usdkrw', 'eurkrw', 'jpykrw_100'].includes(level.id);
    const supportSide = level.status.includes('support');
    const line = supportSide ? level.support : level.resistance;
    const direction = level.status === 'below_support'
      ? '5일 지지선 하향 이탈'
      : level.status === 'above_resistance'
        ? '5일 저항선 상향 돌파'
        : supportSide ? '5일 지지선 테스트' : '5일 저항선 테스트';
    const tone = level.status === 'below_support'
      ? isUsdKrw ? '원화 강세 / 달러 약세 압력' : isKrwPair ? '원화 강세 압력' : '하방 압력'
      : level.status === 'above_resistance'
        ? isUsdKrw ? '원화 약세 / 달러 강세 압력' : isKrwPair ? '원화 약세 압력' : '상방 압력'
        : supportSide
          ? isKrwPair ? '원화 강세 흐름 속 하단 테스트' : '지지선 테스트'
          : isKrwPair ? '원화 약세 전환 여부 테스트' : '저항선 테스트';
    signals.push({
      id: `fx-${level.id}-${level.status}`,
      type: 'fx_level',
      title: `${level.label} ${direction} — ${tone}`,
      impact: isBreak ? 'High' : 'Watch',
      relatedGroups: ['FX'],
      summary: `현재 ${fmt(level.current, 2)} · 기준선 ${fmt(line, 2)} · 5일 평균 ${fmt(level.average, 2)}. ${isBreak ? '단기 박스권 이탈 신호로 해석.' : '돌파/이탈 여부를 관찰.'}`,
      source: level.source || 'fxLevels',
      dataTimestamp: metricById.get(level.id)?.timestamp || level.fetchedAt || null,
      status: isBreak ? 'break' : 'near'
    });
  }

  const usdkrw = metricById.get('usdkrw');
  if (usdkrw?.value != null && Math.abs(Number(usdkrw.changePct || 0)) >= 1) {
    const pct = Number(usdkrw.changePct || 0);
    const up = pct > 0;
    const level = fxLevels.find(x => x.id === 'usdkrw');
    const highContext = level?.resistance ? ` 5일 저항선 ${fmt(level.resistance, 2)}에 근접.` : '';
    signals.push({
      id: 'fx-usdkrw-onepct',
      type: 'fx_move',
      title: `USD/KRW(원/달러) ${up ? '1%대 급등' : '1%대 급락'} — ${up ? '원화 약세/외국인 수급 부담' : '원화 강세/달러 약세'}`,
      impact: 'High',
      relatedGroups: ['FX', 'KR'],
      summary: `현재 1달러=${fmt(usdkrw.value, usdkrw.decimals)}${usdkrw.unit || ''} · 변동률 ${signed(pct)}%. 1% 이상 움직임은 한국 위험자산, 외국인 수급, 수입물가/마진 기대를 동시에 흔드는 신호.${highContext}`,
      source: `${usdkrw.provider}:${usdkrw.symbol}`,
      dataTimestamp: usdkrw.timestamp || null,
      status: 'one_pct_move'
    });
  }

  const gold = metricById.get('gold');
  const btc = metricById.get('btc');
  if (isLiveIssueMetric(gold) && isLiveIssueMetric(btc) && gold?.changePct != null && btc?.changePct != null) {
    const goldPct = Number(gold.changePct || 0);
    const btcPct = Number(btc.changePct || 0);
    const strongEnough = Math.abs(goldPct) >= 0.7 || Math.abs(btcPct) >= 1.2 || (Math.abs(goldPct) >= 0.5 && Math.abs(btcPct) >= 0.8);
    if (strongEnough) {
      const sameDirection = Math.sign(goldPct) === Math.sign(btcPct);
      signals.push({
        id: `cross-gold-btc-${sameDirection ? 'same' : 'inverse'}`,
        type: 'cross_asset',
        title: `금·비트코인 ${sameDirection ? '동반 강세/약세' : '엇갈림'} — 대체자산 선호 구조 확인`,
        impact: Math.abs(goldPct) >= 1 || Math.abs(btcPct) >= 2.5 ? 'High' : 'Watch',
        relatedGroups: ['Commodities', 'Crypto', 'Macro'],
        summary: `금 ${signed(goldPct)}%, BTC ${signed(btcPct)}%. 보통 둘 중 하나로 피난/유동성 선호가 몰리는 날이 많아서, 동반 강세는 광범위한 달러/실질금리 압력, 엇갈림은 위험선호와 헤지 수요의 분리를 뜻할 수 있음.`,
        source: `${gold.provider}:${gold.symbol}; ${btc.provider}:${btc.symbol}`,
        dataTimestamp: latestIso([gold.timestamp, btc.timestamp]),
        status: sameDirection ? 'same_direction' : 'inverse_direction'
      });
    }
  }

  const futuresIds = ['nasdaq_f', 'spx_f'];
  for (const metric of results.filter(m => futuresIds.includes(m.id) && isLiveIssueMetric(m))) {
    const pct = Number(metric.changePct || 0);
    if (Math.abs(pct) < 0.4) continue;
    const up = pct > 0;
    signals.push({
      id: `futures-${metric.id}`,
      type: 'index_move',
      title: `${metric.name} ${pct > 0 ? '강세' : '약세'} — ${up ? '위험선호 우위' : '위험회피 압력'}`,
      impact: Math.abs(pct) >= 1 ? 'High' : 'Watch',
      relatedGroups: ['US Futures', 'US'],
      summary: `현재 ${fmt(metric.value, metric.decimals)}${metric.unit || ''} · 변동률 ${signed(pct)}%. 미국 현물 개장 전 방향성 신호로 관찰.`,
      source: `${metric.provider}:${metric.symbol}`,
      dataTimestamp: metric.timestamp || null,
      status: 'live'
    });
  }

  const usCloseExpiresAt = usCloseMorningIssueExpiresAt(generatedAt);
  const usCloseFresh = isUsCloseSignalFreshForKoreaPreOpen(generatedAt);
  const usCashPair = ['nasdaq100', 'spx']
    .map(id => metricById.get(id))
    .filter(metric => metric?.changePct != null)
    .sort((a, b) => Math.abs(Number(b.changePct || 0)) - Math.abs(Number(a.changePct || 0)));
  const dominantUsCash = usCashPair[0];
  if (usCloseFresh && dominantUsCash && Math.abs(Number(dominantUsCash.changePct || 0)) >= 0.3) {
    const pct = Number(dominantUsCash.changePct || 0);
    const other = usCashPair[1];
    const isNasdaqDominant = dominantUsCash.id === 'nasdaq100';
    const directionLabel = pct > 0 ? '강세' : '약세';
    const title = isNasdaqDominant
      ? `나스닥 100 ${directionLabel}폭 확대 — ${pct > 0 ? '성장주 우위' : '성장주 부담'}`
      : `S&P500 ${directionLabel}폭 확대 — 미 증시 전반 부담 확인`;
    signals.push({
      id: `us-cash-dominant-${dominantUsCash.id}`,
      type: 'us_cash_relative_move',
      title,
      impact: Math.abs(pct) >= 1 ? 'High' : 'Watch',
      relatedGroups: isNasdaqDominant ? ['US', 'Growth'] : ['US', 'Broad Market'],
      summary: `${dominantUsCash.name} ${signed(pct)}%${other ? ` vs ${other.name} ${signed(Number(other.changePct || 0))}%` : ''}. 미국장 마감 후 한국장 전까지 보는 신호이며 09:00 KST에 자동 제외. ${isNasdaqDominant ? '나스닥이 더 크게 움직이면 한국 성장주·반도체 민감도를 우선 확인.' : 'S&P500이 더 크게 움직이면 성장주 단독 이슈보다 미 증시 전반의 위험선호/방어주 흐름을 같이 확인.'}`,
      source: `${dominantUsCash.provider}:${dominantUsCash.symbol}`,
      dataTimestamp: dominantUsCash.timestamp || null,
      status: 'morning_us_close_lead',
      expiresAt: usCloseExpiresAt
    });
  }

  const usTreasuries = ['us10y', 'us2y', 'us30y']
    .map(id => metricById.get(id))
    .filter(metric => metric?.change != null && metric?.value != null)
    .map(metric => {
      const value = Number(metric.value);
      const bp = Number(metric.change) * 100;
      const is10y = metric.id === 'us10y';
      const aboveSensitiveLine = is10y && value >= 4.4;
      const absBp = Math.abs(bp);
      const score = absBp + (aboveSensitiveLine ? 10 : 0) + (is10y ? 1.5 : 0);
      return { metric, value, bp, is10y, aboveSensitiveLine, absBp, score };
    })
    .sort((a, b) => b.score - a.score);
  const dominantTreasury = usTreasuries[0];
  if (usCloseFresh && dominantTreasury) {
    const { metric: usRate, value, bp, is10y, aboveSensitiveLine, absBp } = dominantTreasury;
    const moveThresholdBp = aboveSensitiveLine ? 2 : 4;
    const significantMove = absBp >= moveThresholdBp;
    if (aboveSensitiveLine || significantMove) {
      const rising = bp > 0;
      const title = aboveSensitiveLine
        ? `${usRate.name} 4.40% 상회 — ${rising ? '할인율 부담 확대 경계' : '고금리 부담 구간 지속'}`
        : `${usRate.name} ${rising ? '상승' : '하락'} — ${rising ? '금리 부담 확대' : '금리 부담 완화'}`;
      const rateComparison = usTreasuries
        .slice(0, 3)
        .map(x => `${x.metric.name.replace('미국채 ', '')} ${fmt(x.value, 3)}%(${signed(x.bp, 1)}bp)`)
        .join(' · ');
      const summaryParts = [
        `미국채 중 중요도 최상위: ${rateComparison}.`,
        aboveSensitiveLine
          ? '10Y가 4.40% 상단 경계선을 넘어 Nasdaq/SOX 성장주 밸류에이션과 달러 반응을 더 예민하게 확인.'
          : rising
            ? `${is10y ? '10Y 중심' : usRate.name + ' 중심'} 금리 상승은 성장주 할인율과 달러 반응을 함께 점검.`
            : `${is10y ? '10Y 중심' : usRate.name + ' 중심'} 금리 하락은 성장주 부담 완화와 안전자산 수요를 구분해서 확인.`,
        '미국장 마감 후 한국장 전까지 보는 신호이며 09:00 KST에 자동 제외.'
      ];
      signals.push({
        id: `rates-us-treasury-dominant-${usRate.id}`,
        type: 'rates_move',
        title,
        impact: aboveSensitiveLine || absBp >= 8 ? 'High' : 'Watch',
        relatedGroups: ['Rates', 'US'],
        summary: summaryParts.join(' '),
        source: `${usRate.provider}:${usRate.symbol}`,
        dataTimestamp: usRate.timestamp || null,
        status: aboveSensitiveLine ? 'above_4_40_sensitive' : 'morning_us_close_lead',
        expiresAt: usCloseExpiresAt
      });
    }
  }


  if (usCloseFresh) {
    for (const id of ['sox', 'ewy', 'dram']) {
      const metric = results.find(m => m.id === id);
      const pct = Number(metric?.changePct || 0);
      const threshold = id === 'sox' ? 1.5 : 2.5;
      if (!metric || Math.abs(pct) < threshold) continue;
      const isSox = id === 'sox';
      const isEwy = id === 'ewy';
      const shape = intradayShapes.find(x => x.id === id && Number.isFinite(x.lowPct));
      const recovered = shape && shape.lowPct <= -4 && shape.recoveredPct >= 1;
      signals.push({
        id: `equity-${id}`,
        type: 'equity_move',
        title: `${metric.name} ${pct > 0 ? '강세' : '약세'} — ${isSox ? (pct > 0 ? '반도체 위험선호' : '반도체 리스크오프') : isEwy ? (pct > 0 ? '한국 익스포저 선호' : '한국 익스포저 약세') : (pct > 0 ? '메모리 위험선호' : '메모리 ETF 급락')}`,
        impact: Math.abs(pct) >= 2 ? 'High' : 'Watch',
        relatedGroups: [isSox || id === 'dram' ? 'Semis' : 'KR', 'US'],
        summary: `종가 기준 변동률 ${signed(pct)}%. 미국장 종료 후 신호라 한국장 시작 전인 09:00 KST까지만 오늘의 이슈에 표시. ${recovered ? `장중 저점 ${signed(shape.lowPct)}%에서 종가 ${signed(shape.closePct)}%까지 낙폭을 ${fmt(shape.recoveredPct, 1)}%p 줄인 특이 패턴. ` : ''}${isSox ? 'Nasdaq/DRAM/AI 체인과 동조 여부 확인.' : isEwy ? 'USD/KRW와 KOSPI200 선물 수급 동조 여부 확인.' : 'SOX·HBM/메모리 체인과 한국 반도체 민감도 확인.'}`,
        source: `${metric.provider}:${metric.symbol}${shape ? `; ${shape.source}` : ''}`,
        dataTimestamp: metric.timestamp || shape?.lastTimestamp || null,
        status: 'fresh_us_lead',
        expiresAt: usCloseExpiresAt
      });
    }
  }

  if (usCloseFresh) {
    const closeCandidates = [];
    if (dominantUsCash && Math.abs(Number(dominantUsCash.changePct || 0)) >= 0.3) {
      const other = usCashPair[1];
      closeCandidates.push({
        label: `미국지수: ${dominantUsCash.name} ${signed(Number(dominantUsCash.changePct || 0))}%${other ? ` vs ${other.name} ${signed(Number(other.changePct || 0))}%` : ''}`,
        score: Math.abs(Number(dominantUsCash.changePct || 0)) * 1.2,
        source: `${dominantUsCash.provider}:${dominantUsCash.symbol}`,
        timestamp: dominantUsCash.timestamp || null
      });
    }
    if (dominantTreasury && (dominantTreasury.aboveSensitiveLine || dominantTreasury.absBp >= (dominantTreasury.aboveSensitiveLine ? 2 : 4))) {
      closeCandidates.push({
        label: `미국채: ${dominantTreasury.metric.name} ${fmt(dominantTreasury.value, 3)}%(${signed(dominantTreasury.bp, 1)}bp)`,
        score: dominantTreasury.absBp / 2 + (dominantTreasury.aboveSensitiveLine ? 4 : 0),
        source: `${dominantTreasury.metric.provider}:${dominantTreasury.metric.symbol}`,
        timestamp: dominantTreasury.metric.timestamp || null
      });
    }
    const koreaLead = ['ewy', 'dram']
      .map(id => metricById.get(id))
      .filter(metric => metric?.changePct != null)
      .sort((a, b) => Math.abs(Number(b.changePct || 0)) - Math.abs(Number(a.changePct || 0)))[0];
    if (koreaLead && Math.abs(Number(koreaLead.changePct || 0)) >= 2.5) {
      closeCandidates.push({
        label: `${koreaLead.id === 'ewy' ? '한국 익스포저' : '메모리/DRAM'}: ${koreaLead.name} ${signed(Number(koreaLead.changePct || 0))}%`,
        score: Math.abs(Number(koreaLead.changePct || 0)) * (koreaLead.id === 'dram' ? 1.15 : 1),
        source: `${koreaLead.provider}:${koreaLead.symbol}`,
        timestamp: koreaLead.timestamp || null
      });
    }
    closeCandidates.sort((a, b) => b.score - a.score);
    if (closeCandidates.length) {
      const top = closeCandidates[0];
      signals.push({
        id: 'us-close-morning-brief',
        type: 'us_close_morning_brief',
        title: `미국장 마감 핵심 — ${top.label.split(':')[0]} 이슈 우선`,
        impact: closeCandidates.some(x => x.score >= 4) ? 'High' : 'Watch',
        relatedGroups: ['US', 'KR Open'],
        summary: `${closeCandidates.map(x => x.label).join(' / ')}. 한국장 09:00 전까지 미국장 마감 정보를 압축해서 보여주는 카드이며, 09:00 KST에 자동 제외.`,
        source: closeCandidates.map(x => x.source).join('; '),
        dataTimestamp: latestIso(closeCandidates.map(x => x.timestamp)),
        status: 'us_close_until_09',
        expiresAt: usCloseExpiresAt
      });
    }
  }

  const nightFuture = metricById.get('kospi200_night_futures_kis');
  if (isKoreaNightFuturesIssueEligible(nightFuture, generatedAt) && Math.abs(Number(nightFuture.changePct || 0)) >= 0.8) {
    const pct = Number(nightFuture.changePct || 0);
    signals.push({
      id: 'kr-kospi200-night-futures',
      type: 'korea_night_futures_move',
      title: `KOSPI200 야간선물 ${pct > 0 ? '강세' : '급락'} — 한국장 시초가 압력`,
      impact: Math.abs(pct) >= 1.5 ? 'High' : 'Watch',
      relatedGroups: ['KR', 'Futures', 'KIS'],
      summary: `현재 ${fmt(nightFuture.value, nightFuture.decimals)}${nightFuture.unit || ''} · 변동률 ${signed(pct)}%. 전일 야간선물은 정규장 전 한국 현물/선물 갭 방향을 가장 직접적으로 보여주는 참고값.${nightFuture.raw?.low ? ` 야간 저가 ${fmt(nightFuture.raw.low, nightFuture.decimals)}.` : ''}`,
      source: `${nightFuture.provider}:${nightFuture.symbol}`,
      dataTimestamp: nightFuture.timestamp || nightFuture.fetchedAt || null,
      status: nightFuture.status?.level === 'closed' ? 'closed_reference' : 'live'
    });
  }

  const koreaCoreMoves = ['kospi', 'kospi200', 'kospi200_futures_kis']
    .map(id => ({ id, metric: results.find(m => m.id === id) }))
    .filter(({ id, metric }) => isKoreaIndexMoveSignalEligible(id, metric, generatedAt))
    .sort((a, b) => Math.abs(Number(b.metric.changePct || 0)) - Math.abs(Number(a.metric.changePct || 0)));
  const kosdaqMetric = results.find(m => m.id === 'kosdaq');
  const kosdaqMove = isKoreaIndexMoveSignalEligible('kosdaq', kosdaqMetric, generatedAt) ? kosdaqMetric : null;
  for (const { id, metric } of [...koreaCoreMoves.slice(0, 1).map(x => x), ...(kosdaqMove ? [{ id: 'kosdaq', metric: kosdaqMove }] : [])]) {
    const pct = Number(metric.changePct || 0);
    const up = pct > 0;
    const isCore = ['kospi', 'kospi200', 'kospi200_futures_kis'].includes(id);
    const label = id === 'kospi200_futures_kis' ? 'KOSPI200 선물' : metric.name;
    const tone = up
      ? (isCore ? '한국 위험자산 강세 / 외국인 수급 개선 가능성' : '코스닥 위험선호')
      : (isCore ? '한국 위험자산 약세 / 수급 부담' : '코스닥 리스크오프');
    const comparison = isCore && koreaCoreMoves.length > 1
      ? ` 한국 핵심 3종(KOSPI/KOSPI200/선물) 중 변동폭 최상위만 표시.`
      : '';
    signals.push({
      id: `kr-${id}`,
      type: 'korea_index_move',
      title: `${label} ${up ? '급등' : '급락'} — ${tone}`,
      impact: Math.abs(pct) >= 2 ? 'High' : 'Watch',
      relatedGroups: ['KR', id === 'kospi200_futures_kis' ? 'KIS' : 'FX'],
      summary: `현재 ${fmt(metric.value, metric.decimals)}${metric.unit || ''} · 변동률 ${signed(pct)}%. USD/KRW, EWY, SOX, KOSPI200 선물 수급과 동조 여부 확인.${comparison}`,
      source: `${metric.provider}:${metric.symbol}`,
      dataTimestamp: metric.timestamp || null,
      status: metric.status?.level === 'closed' ? 'closed_snapshot' : 'live'
    });
  }

  const kospi200Flow = investorFlows.find(flow => flow.id === 'kospi200_futures' && flow.status === 'ok');
  if (isKrxFuturesInvestorFlowIssueEligible(kospi200Flow, generatedAt) && kospi200Flow.foreignNetBuy !== null) {
    const net = Number(kospi200Flow.foreignNetBuy);
    const absNet = Math.abs(net);
    if (absNet >= 300) {
      signals.push({
        id: 'flow-kospi200-futures-foreign',
        type: 'investor_flow',
        title: `외국인 KOSPI200 선물 ${net > 0 ? '순매수' : '순매도'} — ${net > 0 ? '선물 수급 우호' : '선물 수급 부담'}`,
        impact: absNet >= 1000 ? 'High' : 'Watch',
        relatedGroups: ['KR', 'KIS', 'FX'],
        summary: `외국인 매수 ${fmt(kospi200Flow.foreignBuy, 0)} / 매도 ${fmt(kospi200Flow.foreignSell, 0)} / 순매수 ${signed(net, 0)}십억원. KOSPI200 정규 선물장 중에만 표시하는 실시간성 수급 지표.`,
        source: kospi200Flow.source,
        dataTimestamp: kospi200Flow.fetchedAt || null,
        status: 'intraday'
      });
    }
  }

  return signals
    .map(withOccurrenceTime)
    .sort((a, b) => impactRank(b.impact) - impactRank(a.impact))
    .slice(0, 12);
}


function buildKospiVolatilityLevelSignal(metric, generatedAt) {
  if (!metric || metric.value === null || metric.value === undefined || metric.status?.level === 'error') return null;
  if (!isKoreaCashIssueWindow(generatedAt)) return null;

  const value = Number(metric.value);
  if (!Number.isFinite(value)) return null;
  const level = KOSPI_VOLATILITY_LEVELS.find(x => value >= x.min && value < x.max);
  if (!level) return null;

  const dataTimestamp = metric.timestamp || metric.fetchedAt || generatedAt;
  const marketOpenAt = koreaMarketOpenAt(generatedAt);
  const isMorningOpenLevel = new Date(generatedAt).getTime() < marketOpenAt.getTime() + 3 * 60 * 60 * 1000;
  const ttlMinutes = isMorningOpenLevel ? Math.ceil((marketOpenAt.getTime() + 3 * 60 * 60 * 1000 - new Date(generatedAt).getTime()) / 60000) : 180;
  const openLabel = isMorningOpenLevel ? '09시 기준' : '장중 레벨 변화';

  return {
    id: 'kr-kospi-volatility-level',
    type: 'kospi_volatility_level',
    title: `KOSPI 변동성지수 ${openLabel}: ${fmt(value, metric.decimals ?? 2)} — ${level.label}`,
    impact: level.impact,
    relatedGroups: ['KR', 'Volatility'],
    summary: `${level.guidance}. 등락폭보다 현재 레벨 자체를 기준으로 해석합니다. 데이터 시각 ${dataTimestamp ? new Date(dataTimestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '미정'}.`,
    source: `${metric.provider}:${metric.symbol}`,
    dataTimestamp,
    status: `vol_${level.key}`,
    ttlMinutes: Math.max(1, ttlMinutes)
  };
}

function buildKospiDistanceSignal(metric, generatedAt) {
  if (!metric || metric.value === null || metric.value === undefined || metric.status?.level === 'error') return null;
  if (!isKstKospiDistanceMorningWindow(generatedAt)) return null;

  const distance = Number(metric.value);
  const threshold = 128;
  if (!Number.isFinite(distance) || distance <= threshold) return null;

  const current = Number(metric.raw?.current);
  const movingAverage = Number(metric.raw?.movingAverage);
  const period = Number(metric.raw?.period || 60);
  const sampleRange = [metric.raw?.firstSampleDate, metric.raw?.lastSampleDate].filter(Boolean).join('~');

  return {
    id: 'kr-kospi-distance-60-overheat',
    type: 'kospi_distance_overheat',
    title: `KOSPI ${period}일 이격도 ${fmt(distance, metric.decimals ?? 2)} — 과열 신호`,
    impact: 'High',
    relatedGroups: ['KR', 'Overheat'],
    summary: `60일 이격도가 기준선 ${fmt(threshold, 0)}을 초과했습니다. 현재 KOSPI ${Number.isFinite(current) ? fmt(current, 2) : '—'} / ${period}일 평균 ${Number.isFinite(movingAverage) ? fmt(movingAverage, 2) : '—'} 기준. 단기 과열·추격매수 위험 신호로 보고 09~11시 KST에만 표시합니다.${sampleRange ? ` 표본 ${sampleRange}.` : ''}`,
    source: `${metric.provider}:${metric.symbol}`,
    dataTimestamp: metric.timestamp || metric.fetchedAt || generatedAt,
    status: 'distance_over_128',
    expiresAt: kstElevenAt(generatedAt).toISOString()
  };
}

function isKstKospiDistanceMorningWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  return minutes >= 9 * 60 && minutes < 11 * 60;
}

function kstElevenAt(nowIso = new Date().toISOString()) {
  const kstDate = formatKstDate(new Date(nowIso));
  return new Date(`${kstDate}T11:00:00+09:00`);
}

function koreaMarketOpenAt(nowIso = new Date().toISOString()) {
  const kstDate = formatKstDate(new Date(nowIso));
  return new Date(`${kstDate}T09:00:00+09:00`);
}


function buildHighYieldSpreadLevelSignal(metric, generatedAt) {
  if (!metric || metric.value === null || metric.value === undefined || metric.status?.level === 'error') return null;
  if (!isKstMorningIssueWindow(generatedAt)) return null;

  const value = Number(metric.value);
  const previousValue = Number(metric.raw?.previousValue);
  if (!Number.isFinite(value) || !Number.isFinite(previousValue)) return null;

  const level = HIGH_YIELD_SPREAD_LEVELS.find(x => value >= x.min && value < x.max);
  const previousLevel = HIGH_YIELD_SPREAD_LEVELS.find(x => previousValue >= x.min && previousValue < x.max);
  if (!level || !previousLevel || level.key === previousLevel.key) return null;

  return {
    id: 'us-high-yield-spread-level',
    type: 'credit_spread_level',
    title: `하이일드 스프레드 레벨 변화: ${fmt(value, metric.decimals ?? 0)}bp — ${level.label}`,
    impact: level.impact,
    relatedGroups: ['Credit', 'Rates', 'US'],
    summary: `${previousLevel.label}(${fmt(previousValue, metric.decimals ?? 0)}bp) → ${level.label}(${fmt(value, metric.decimals ?? 0)}bp). ${level.guidance}. FRED 일별 OAS 기준이라 09~12시 KST에만 오늘의 이슈로 확인합니다.`,
    source: `${metric.provider}:${metric.symbol}`,
    dataTimestamp: metric.timestamp || metric.fetchedAt || generatedAt,
    status: `hy_${previousLevel.key}_to_${level.key}`,
    expiresAt: kstNoonAt(generatedAt).toISOString()
  };
}

function isKstMorningIssueWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  return minutes >= 9 * 60 && minutes < 12 * 60;
}

function kstNoonAt(nowIso = new Date().toISOString()) {
  const kstDate = formatKstDate(new Date(nowIso));
  return new Date(`${kstDate}T12:00:00+09:00`);
}

function buildKoreaMarketSafetySignals(metricById, generatedAt) {
  const signals = [];
  const futures = metricById.get('kospi200_futures_kis');
  const kospi = metricById.get('kospi');
  const kosdaq = metricById.get('kosdaq');

  if (isKoreaDayFuturesIssueWindow(generatedAt) && futures?.status?.level === 'ok' && futures.changePct !== null && futures.changePct !== undefined) {
    const pct = Number(futures.changePct);
    if (Number.isFinite(pct) && Math.abs(pct) >= 5) {
      const buySide = pct > 0;
      signals.push({
        id: `kr-sidecar-${buySide ? 'buy' : 'sell'}`,
        type: 'korea_market_safety_mechanism',
        title: `KOSPI 사이드카 ${buySide ? '매수' : '매도'} 발동권 — KOSPI200 선물 ${signed(pct)}%`,
        impact: 'High',
        relatedGroups: ['KR', 'Futures', 'Market Safety'],
        summary: `KOSPI200 선물 변동률이 ${signed(pct)}%로 사이드카 감시 기준권에 진입했습니다. ${buySide ? '급등 방향이므로 매수 사이드카/프로그램 매수 제한 여부' : '급락 방향이므로 매도 사이드카/프로그램 매도 제한 여부'}를 즉시 확인해야 합니다. 이 카드는 1시간만 노출됩니다.`,
        source: `${futures.provider}:${futures.symbol}; deterministic KRX sidecar threshold monitor`,
        dataTimestamp: futures.timestamp || futures.fetchedAt || generatedAt,
        status: buySide ? 'sidecar_buy' : 'sidecar_sell',
        ttlMinutes: 60
      });
    }
  }

  for (const metric of [kospi, kosdaq].filter(Boolean)) {
    if (!isKoreaCashIssueWindow(generatedAt)) continue;
    if (!isSameKstDate(metric.timestamp, generatedAt)) continue;
    const pct = Number(metric.changePct);
    if (!Number.isFinite(pct) || pct > -8) continue;
    const level = pct <= -20 ? '3단계' : pct <= -15 ? '2단계' : '1단계';
    signals.push({
      id: `kr-circuit-breaker-${metric.id}-${level}`,
      type: 'korea_market_safety_mechanism',
      title: `${metric.name} 서킷브레이커 ${level} 발동권 — ${signed(pct)}%`,
      impact: 'High',
      relatedGroups: ['KR', 'Market Safety'],
      summary: `${metric.name} 변동률이 ${signed(pct)}%로 서킷브레이커 ${level} 감시 기준권에 진입했습니다. 현물시장 거래중단/재개 여부를 즉시 확인해야 합니다. 이 카드는 1시간만 노출됩니다.`,
      source: `${metric.provider}:${metric.symbol}; deterministic KRX circuit-breaker threshold monitor`,
      dataTimestamp: metric.timestamp || metric.fetchedAt || generatedAt,
      status: `circuit_breaker_${level}`,
      ttlMinutes: 60
    });
  }

  return signals;
}

async function applyMarketSignalOccurrenceState(signals, nowIso) {
  const stateFile = path.join(root, 'data', 'issue-state.json');
  let previous = {};
  try {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    previous = state.active || {};
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const active = {};
  const normalized = signals.map(signal => {
    const key = issueStateKey(signal);
    const existing = previous[key];
    const firstSeenAt = existing?.firstSeenAt || signal.occurredAt || nowIso;
    const ttlExpiresAt = signal.ttlMinutes ? new Date(new Date(firstSeenAt).getTime() + Number(signal.ttlMinutes) * 60 * 1000).toISOString() : null;
    const expiresAt = existing?.expiresAt || ttlExpiresAt || signal.expiresAt || null;
    const freezeSnapshot = signal.type === 'kospi_volatility_level' && existing;
    const outputSignal = freezeSnapshot
      ? {
        ...signal,
        title: existing.title || signal.title,
        summary: existing.summary || signal.summary,
        impact: existing.impact || signal.impact,
        source: existing.source || signal.source,
        dataTimestamp: existing.dataTimestamp || signal.dataTimestamp
      }
      : signal;
    active[key] = {
      firstSeenAt,
      lastSeenAt: nowIso,
      id: signal.id || null,
      type: signal.type || null,
      status: signal.status || null,
      title: outputSignal.title || null,
      summary: outputSignal.summary || null,
      impact: outputSignal.impact || null,
      source: outputSignal.source || null,
      dataTimestamp: outputSignal.dataTimestamp || null,
      expiresAt
    };
    return { ...outputSignal, occurredAt: firstSeenAt, lastSeenAt: nowIso, expiresAt };
  });

  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await writeJsonAtomic(stateFile, { updatedAt: nowIso, active });
  return normalized;
}

function issueStateKey(signal) {
  return [
    signal.id || signal.type || 'issue',
    signal.status || 'status:none',
    signal.dataTimestamp ? `data-date:${formatKstDate(new Date(signal.dataTimestamp))}` : null
  ].filter(Boolean).join('|');
}

function latestIso(values = []) {
  const dates = values
    .map(value => value ? new Date(value) : null)
    .filter(date => date && !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return dates[0]?.toISOString() || null;
}

function isLiveIssueMetric(metric) {
  if (!metric) return false;
  const level = metric.status?.level || '';
  return level !== 'closed' && level !== 'error' && metric.value !== null && metric.value !== undefined;
}

function isKoreaIndexMoveSignalEligible(id, metric, nowIso) {
  if (!isLiveIssueMetric(metric) || Math.abs(Number(metric.changePct || 0)) < 1) return false;

  if (['kospi', 'kospi200', 'kosdaq'].includes(id)) {
    if (!isSameKstDate(metric.timestamp, nowIso)) return false;
    // Korean cash index move cards are intraday issue cards, not end-of-day recap.
    // After the 15:30 KST cash close, keep values in metric cards but remove them from 오늘의 이슈.
    if (!isKoreaCashIssueWindow(nowIso)) return false;
  }

  if (id === 'kospi200_futures_kis' && !isKoreaDayFuturesIssueWindow(nowIso)) return false;

  return true;
}

function isKoreaCashIssueWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  if (!isMarketOpen('kr_cash_day', now)) return false;
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  return minutes >= 9 * 60 && minutes < 15 * 60 + 30;
}

function isKoreaDayFuturesIssueWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  if (!isMarketOpen('kr_derivatives_day', now)) return false;
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  return minutes >= 8 * 60 + 45 && minutes < 15 * 60 + 45;
}

function isKoreaNightFuturesIssueEligible(metric, nowIso = new Date().toISOString()) {
  if (!metric || metric.changePct == null) return false;
  if (wasLatestKrxNightSessionHolidayClosed(new Date(nowIso))) return false;
  const marketState = metric.status?.marketState || '';
  const statusLevel = metric.status?.level || '';

  // Real NGT ticks are valid issues only during the KRX night-futures window.
  // Closed/reference values (Chartlog fallback) are useful for pre-open context,
  // but should not stay in 오늘의 이슈 during the Korean cash/futures session.
  if (marketState === 'KIS_NGT_WS' && statusLevel !== 'closed') return isKoreaNightFuturesLiveWindow(nowIso);
  if (marketState === 'kr_derivatives_night_CLOSED_REFERENCE' || statusLevel === 'closed') return isKoreaPreOpenNightReferenceWindow(nowIso);

  return false;
}

function isKoreaNightFuturesLiveWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  // Conservative display window for KRX night derivatives: evening through early morning.
  return minutes >= 18 * 60 || minutes < 5 * 60;
}

function isKoreaPreOpenNightReferenceWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  // After the night session has ended, keep the reference only as a Korea-open handoff.
  return minutes >= 5 * 60 && minutes < 9 * 60;
}

function isKrxFuturesInvestorFlowIssueEligible(flow, nowIso = new Date().toISOString()) {
  if (!flow || flow.status !== 'ok') return false;
  if (!isKoreaDayFuturesIssueWindow(nowIso)) return false;
  if (!flow.tradeDate) return false;
  return String(flow.tradeDate).replace(/\D/g, '') === formatKstDateCompact(new Date(nowIso));
}

function isSameKstDate(leftIso, rightIso) {
  if (!leftIso || !rightIso) return false;
  const left = new Date(leftIso);
  const right = new Date(rightIso);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return false;
  return formatKstDate(left) === formatKstDate(right);
}

function formatKstDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function formatKstDateCompact(date) {
  return formatKstDate(date).replace(/-/g, '');
}

function compactKrxDateToIso(value) {
  const text = String(value || '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(text)) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function impactRank(impact) {
  return impact === 'High' ? 3 : impact === 'Watch' ? 2 : 1;
}

function isUsCloseSignalFreshForKoreaPreOpen(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  // US cash/ETF close signals are an overnight-to-Korea-open handoff.
  // Keep them visible only after the normal US-market close window and before Korea cash opens.
  return minutes >= 5 * 60 && minutes < 9 * 60;
}

function usCloseMorningIssueExpiresAt(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const kstDate = formatKstDate(now);
  const expires = new Date(`${kstDate}T09:00:00+09:00`);
  if (now.getTime() < expires.getTime()) return expires.toISOString();
  const tomorrow = new Date(expires.getTime() + 24 * 60 * 60 * 1000);
  return tomorrow.toISOString();
}

function partsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

function fmt(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function signed(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(decimals)}`;
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
      const value = trimmed.slice(idx + 1).trim().replace(/^[\'"]|[\'"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
