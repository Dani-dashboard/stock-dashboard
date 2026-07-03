import { failedStatus, normalizeValue, okStatus, closedStatus, delayedStatus } from '../status.mjs';


function tradingPeriodState(meta, nowSec = Math.floor(Date.now() / 1000)) {
  const periods = meta.currentTradingPeriod || {};
  for (const name of ['pre', 'regular', 'post']) {
    const p = periods[name];
    if (p && Number.isFinite(p.start) && Number.isFinite(p.end) && nowSec >= p.start && nowSec <= p.end) return name.toUpperCase();
  }
  if (periods.regular?.end && nowSec > periods.regular.end) return 'CLOSED';
  if (periods.regular?.start && nowSec < periods.regular.start) return 'PRE_OPEN';
  return meta.marketState || 'UNKNOWN';
}

function zonedParts(timeZone = 'America/New_York', date = new Date()) {
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

function isWeekendClosed(meta, ageSeconds, staleSeconds) {
  if (ageSeconds === null || ageSeconds <= staleSeconds) return false;
  const parts = zonedParts(meta.exchangeTimezoneName || 'America/New_York');
  const minutes = parts.hour * 60 + parts.minute;
  // CME index futures close for the weekend Friday evening and reopen Sunday evening.
  // Yahoo can keep futures labeled REGULAR after the final Friday print.
  if (parts.weekday === 'Fri' && minutes >= 18 * 60) return true;
  if (parts.weekday === 'Sat') return true;
  if (parts.weekday === 'Sun' && parts.hour < 18) return true;
  return false;
}

function isCmeFuturesMaintenanceClosed(metric, ts, ageSeconds, staleSeconds) {
  if (ageSeconds === null || ageSeconds <= staleSeconds) return false;
  if (!/^(NQ|ES)=F$/i.test(metric?.symbol || '')) return false;
  if (!ts) return false;
  const timeZone = 'America/New_York';
  const nowParts = zonedParts(timeZone);
  const tickParts = zonedParts(timeZone, new Date(ts));
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  const tickMinutes = tickParts.hour * 60 + tickParts.minute;
  // CME equity index futures pause daily around 17:00-18:00 ET. Yahoo can
  // leave the session metadata open while the last tick is a 16:59 ET print.
  return nowMinutes >= 17 * 60 && nowMinutes < 18 * 60 && tickMinutes >= (16 * 60 + 55);
}

export async function fetchYahooMetric(metric, { timeoutMs = 8000, staleSeconds = 180 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(metric.symbol)}?range=1d&interval=1m`;

  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'stock-dashboard-mvp/0.1' } });
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(json?.chart?.error?.description || 'Yahoo empty result');

    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    let lastIndex = closes.length - 1;
    while (lastIndex >= 0 && (closes[lastIndex] === null || closes[lastIndex] === undefined)) lastIndex -= 1;

    const hasClose = lastIndex >= 0;
    const raw = hasClose ? closes[lastIndex] : meta.regularMarketPrice;
    if (raw === null || raw === undefined) throw new Error('Yahoo has no latest close or market price');

    const value = normalizeValue(raw, metric.scale ?? 1);
    const previousClose = normalizeValue(meta.previousClose ?? meta.chartPreviousClose, metric.scale ?? 1);
    const change = previousClose === null ? null : value - previousClose;
    const changePct = previousClose ? (change / previousClose) * 100 : null;
    const tsSec = hasClose ? timestamps[lastIndex] : meta.regularMarketTime;
    const ts = tsSec ? new Date(tsSec * 1000).toISOString() : null;
    const marketState = tradingPeriodState(meta);
    const ageSeconds = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 1000) : null;
    const weekendClosed = isWeekendClosed(meta, ageSeconds, staleSeconds);
    const cmeMaintenanceClosed = isCmeFuturesMaintenanceClosed(metric, ts, ageSeconds, staleSeconds);
    const state = marketState === 'CLOSED' || marketState === 'PRE_OPEN' || weekendClosed || cmeMaintenanceClosed
      ? closedStatus({
          marketState: weekendClosed ? 'WEEKEND_CLOSED' : cmeMaintenanceClosed ? 'CME_FUTURES_MAINTENANCE_CLOSED' : marketState,
          ageSeconds,
          message: weekendClosed
            ? `Yahoo weekend/closed-market print; latest tick is ${ageSeconds}s old`
            : cmeMaintenanceClosed
              ? `Yahoo CME futures maintenance/closed-market print; latest tick is ${ageSeconds}s old`
              : undefined
        })
      : ageSeconds !== null && ageSeconds > staleSeconds
        ? delayedStatus({ marketState, ageSeconds, message: `latest tick is ${ageSeconds}s old` })
        : okStatus({ marketState, ageSeconds });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'yahoo',
      symbol: metric.symbol,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value,
      change,
      changePct,
      timestamp: ts,
      fetchedAt: new Date().toISOString(),
      status: state,
      delayNote: metric.delayNote || null,
      sourceUrl: url
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Yahoo timeout' : err.message;
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'yahoo',
      symbol: metric.symbol,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: null,
      change: null,
      changePct: null,
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      status: failedStatus(message),
      sourceUrl: url
    };
  } finally {
    clearTimeout(timeout);
  }
}
