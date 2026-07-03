import { failedStatus, normalizeValue, okStatus, closedStatus, delayedStatus } from '../status.mjs';

function marketParts(timeZone = 'Asia/Seoul', date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type === 'weekday') acc.weekday = part.value;
    if (part.type === 'hour') acc.hour = Number(part.value);
    if (part.type === 'minute') acc.minute = Number(part.value);
    return acc;
  }, { weekday: '', hour: 0, minute: 0 });
}

function isLocalWeekendOrPreOpen(metric, ageSeconds, staleSeconds) {
  if (ageSeconds === null || ageSeconds <= staleSeconds) return false;
  const zone = /^JP/i.test(metric?.symbol || '') ? 'Asia/Tokyo' : 'Asia/Seoul';
  const p = marketParts(zone);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return true;
  if (p.hour < 9 || (p.hour === 9 && p.minute === 0)) return true;
  return false;
}

export async function fetchNaverIndexMetric(metric, { timeoutMs = 8000, staleSeconds = 180 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const code = metric.naverCode || metric.symbol;
  const base = metric.naverEndpoint === 'worldIndex' ? 'https://api.stock.naver.com/index' : 'https://m.stock.naver.com/api/index';
  const url = `${base}/${encodeURIComponent(code)}/basic`;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 stock-dashboard-mvp/0.1' } });
    if (!res.ok) throw new Error(`Naver HTTP ${res.status}`);
    const json = await res.json();
    const value = parseNaverNumber(json.closePrice);
    if (value === null) throw new Error('Naver has no closePrice');
    const change = parseNaverNumber(json.compareToPreviousClosePrice);
    const changePct = parseNaverNumber(json.fluctuationsRatio);
    const timestamp = json.localTradedAt || json.delayTimeName || null;
    const marketStatus = json.marketStatus || json.stockExchangeType?.name || 'UNKNOWN';
    const ageSeconds = timestamp ? Math.round((Date.now() - new Date(timestamp).getTime()) / 1000) : null;
    const isClosed = ['CLOSE', 'CLOSED'].includes(String(marketStatus).toUpperCase());
    const state = isClosed
      ? closedStatus({ marketState: marketStatus, ageSeconds })
      : ageSeconds !== null && ageSeconds > staleSeconds
        ? delayedStatus({ marketState: marketStatus, ageSeconds, message: `latest tick is ${ageSeconds}s old` })
        : okStatus({ marketState: marketStatus, ageSeconds });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'naver',
      symbol: code,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: normalizeValue(value, metric.scale ?? 1),
      change: normalizeValue(change, metric.scale ?? 1),
      changePct,
      timestamp,
      fetchedAt: new Date().toISOString(),
      status: state,
      delayNote: metric.delayNote || null,
      sourceUrl: url
    };
  } catch (err) {
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'naver',
      symbol: code,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: null,
      change: null,
      changePct: null,
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      status: failedStatus(err.name === 'AbortError' ? 'Naver timeout' : err.message),
      sourceUrl: url
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchNaverIndexDistanceMetric(metric, { timeoutMs = 8000, staleSeconds = 180 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const code = metric.naverCode || metric.symbol || 'KOSPI';
  const period = Number(metric.distancePeriod || 60);
  const endDate = formatDateCompact(new Date());
  const startDate = formatDateCompact(new Date(Date.now() - 370 * 24 * 60 * 60 * 1000));
  const basicUrl = `https://m.stock.naver.com/api/index/${encodeURIComponent(code)}/basic`;
  const chartUrl = `https://api.stock.naver.com/chart/domestic/index/${encodeURIComponent(code)}/day?startDateTime=${startDate}&endDateTime=${endDate}`;

  try {
    const headers = { 'user-agent': 'Mozilla/5.0 stock-dashboard-mvp/0.1', accept: 'application/json,text/plain,*/*' };
    const [basicRes, chartRes] = await Promise.all([
      fetch(basicUrl, { signal: controller.signal, headers }),
      fetch(chartUrl, { signal: controller.signal, headers })
    ]);
    if (!basicRes.ok) throw new Error(`Naver index basic HTTP ${basicRes.status}`);
    if (!chartRes.ok) throw new Error(`Naver index chart HTTP ${chartRes.status}`);

    const basic = await basicRes.json();
    const chart = await chartRes.json();
    const current = parseNaverNumber(basic.closePrice);
    if (current === null) throw new Error('Naver index distance has no current closePrice');
    if (!Array.isArray(chart) || chart.length < period) throw new Error(`Naver index distance has only ${Array.isArray(chart) ? chart.length : 0} samples`);

    const today = formatDateCompact(new Date());
    const prices = chart
      .map(row => ({ date: String(row.localDate || ''), close: parseNaverNumber(row.closePrice) }))
      .filter(row => row.date && row.close !== null)
      .sort((a, b) => a.date.localeCompare(b.date));

    const last = prices[prices.length - 1];
    if (last?.date === today) last.close = current;
    else prices.push({ date: today, close: current });

    const window = prices.slice(-period);
    if (window.length < period) throw new Error(`Naver index distance has only ${window.length} usable samples`);
    const movingAverage = window.reduce((sum, row) => sum + row.close, 0) / window.length;
    const distance = movingAverage ? (current / movingAverage) * 100 : null;
    if (distance === null || !Number.isFinite(distance)) throw new Error('Naver index distance calculation failed');

    const timestamp = basic.localTradedAt || `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}T00:00:00+09:00`;
    const marketStatus = basic.marketStatus || basic.stockExchangeType?.name || 'UNKNOWN';
    const ageSeconds = timestamp ? Math.round((Date.now() - new Date(timestamp).getTime()) / 1000) : null;
    const isClosed = ['CLOSE', 'CLOSED'].includes(String(marketStatus).toUpperCase());
    const state = isClosed
      ? closedStatus({ marketState: marketStatus, ageSeconds, message: `${period}일 이격도 계산값; current=${current}; ma${period}=${movingAverage.toFixed(2)}` })
      : ageSeconds !== null && ageSeconds > staleSeconds
        ? delayedStatus({ marketState: marketStatus, ageSeconds, message: `${period}일 이격도 quote is ${ageSeconds}s old; current=${current}; ma${period}=${movingAverage.toFixed(2)}` })
        : okStatus({ marketState: marketStatus, ageSeconds, message: `${period}일 이격도; current=${current}; ma${period}=${movingAverage.toFixed(2)}` });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'naverIndexDistance',
      symbol: code,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: normalizeValue(distance, metric.scale ?? 1),
      change: null,
      changePct: null,
      timestamp,
      fetchedAt: new Date().toISOString(),
      status: state,
      delayNote: metric.delayNote || null,
      sourceUrl: chartUrl,
      raw: {
        current,
        movingAverage,
        period,
        sampleCount: window.length,
        firstSampleDate: window[0]?.date || null,
        lastSampleDate: window[window.length - 1]?.date || null,
        basicUrl,
        chartUrl
      }
    };
  } catch (err) {
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'naverIndexDistance',
      symbol: code,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: null,
      change: null,
      changePct: null,
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      status: failedStatus(err.name === 'AbortError' ? 'Naver index distance timeout' : err.message),
      sourceUrl: chartUrl
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchNaverFxMetric(metric, { timeoutMs = 8000, staleSeconds = 1800 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const code = metric.naverCode || metric.symbol;
  const url = `https://api.stock.naver.com/marketindex/exchange/${encodeURIComponent(code)}`;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 stock-dashboard-mvp/0.1', accept: 'application/json,text/plain,*/*' } });
    if (!res.ok) throw new Error(`Naver FX HTTP ${res.status}`);
    const json = await res.json();
    const info = json.exchangeInfo || json.result;
    if (!info) throw new Error('Naver FX has no exchangeInfo');
    const value = parseNaverNumber(info.closePrice ?? info.calcPrice);
    if (value === null) throw new Error('Naver FX has no closePrice');
    const change = parseNaverNumber(info.fluctuations);
    const changePct = parseNaverNumber(info.fluctuationsRatio);
    const timestamp = info.localTradedAt || null;
    const marketStatus = info.marketStatus || info.stockExchangeType?.name || 'HANA';
    const ageSeconds = timestamp ? Math.round((Date.now() - new Date(timestamp).getTime()) / 1000) : null;
    const isClosed = ['CLOSE', 'CLOSED'].includes(String(marketStatus).toUpperCase());
    const state = isClosed
      ? closedStatus({ marketState: marketStatus, ageSeconds })
      : ageSeconds !== null && ageSeconds > staleSeconds
        ? delayedStatus({ marketState: marketStatus, ageSeconds, message: `Naver/Hana FX quote is ${ageSeconds}s old` })
        : okStatus({ marketState: marketStatus, ageSeconds, message: `${info.description || '하나은행 고시환율'}; ${info.degreeCount ? `${info.degreeCount}회차` : ''}`.trim() });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'naverFx',
      symbol: code,
      unit: metric.unit || info.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: normalizeValue(value, metric.scale ?? 1),
      change: normalizeValue(change, metric.scale ?? 1),
      changePct,
      timestamp,
      fetchedAt: new Date().toISOString(),
      status: state,
      delayNote: metric.delayNote || null,
      sourceUrl: url,
      rawName: info.fullName || info.name || null
    };
  } catch (err) {
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'naverFx',
      symbol: code,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: null,
      change: null,
      changePct: null,
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      status: failedStatus(err.name === 'AbortError' ? 'Naver FX timeout' : err.message),
      sourceUrl: url
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchNaverMarketIndexMetric(metric, { timeoutMs = 8000, staleSeconds = 86400 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const category = metric.naverCategory || 'bond';
  const code = metric.naverCode || metric.symbol;
  const url = `https://m.stock.naver.com/front-api/marketIndex/productDetail?category=${encodeURIComponent(category)}&reutersCode=${encodeURIComponent(code)}`;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 stock-dashboard-mvp/0.1', accept: 'application/json,text/plain,*/*' } });
    if (!res.ok) throw new Error(`Naver market index HTTP ${res.status}`);
    const json = await res.json();
    const info = json.result;
    if (!json.isSuccess || !info || !Object.keys(info).length) throw new Error(json.message || 'Naver market index has no result');
    const value = parseNaverNumber(info.closePrice);
    if (value === null) throw new Error('Naver market index has no closePrice');
    const change = parseNaverNumber(info.fluctuations);
    const changePct = parseNaverNumber(info.fluctuationsRatio);
    const timestamp = info.localTradedAt || null;
    const ageSeconds = timestamp ? Math.round((Date.now() - new Date(timestamp).getTime()) / 1000) : null;
    const marketStatus = info.marketStatus || info.priceDataType || 'NAVER_MARKET_INDEX';
    const isClosed = ['CLOSE', 'CLOSED'].includes(String(marketStatus).toUpperCase());
    const isWeekendClosed = isLocalWeekendOrPreOpen(metric, ageSeconds, staleSeconds);
    const sourceText = [info.name, info.priceDataType, info.delayTimeName].filter(Boolean).join('; ');
    const state = isClosed || isWeekendClosed
      ? closedStatus({
          marketState: isWeekendClosed ? 'LOCAL_WEEKEND_OR_PREOPEN_CLOSED' : marketStatus,
          ageSeconds,
          message: isWeekendClosed ? `Naver market index weekend/pre-open print; quote is ${ageSeconds}s old; ${sourceText}` : undefined
        })
      : ageSeconds !== null && ageSeconds > staleSeconds
        ? delayedStatus({ marketState: marketStatus, ageSeconds, message: `Naver market index quote is ${ageSeconds}s old; ${sourceText}` })
        : okStatus({ marketState: marketStatus, ageSeconds, message: sourceText || 'Naver market index' });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'naverMarketIndex',
      symbol: code,
      unit: metric.unit || info.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: normalizeValue(value, metric.scale ?? 1),
      change: normalizeValue(change, metric.scale ?? 1),
      changePct,
      timestamp,
      fetchedAt: new Date().toISOString(),
      status: state,
      delayNote: metric.delayNote || info.delayTimeName || null,
      sourceUrl: info.endUrl || url,
      rawName: info.name || null,
      priceDataType: info.priceDataType || null
    };
  } catch (err) {
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'naverMarketIndex',
      symbol: code,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: null,
      change: null,
      changePct: null,
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      status: failedStatus(err.name === 'AbortError' ? 'Naver market index timeout' : err.message),
      sourceUrl: url
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseNaverNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/%/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatDateCompact(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date).replace(/-/g, '');
}
