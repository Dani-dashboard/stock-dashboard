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
