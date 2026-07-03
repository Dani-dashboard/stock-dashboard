import { failedStatus, normalizeValue, okStatus, delayedStatus, closedStatus } from '../status.mjs';

function parseCnbcTime(value) {
  if (!value) return null;
  // CNBC timestamps look like `2026-05-05T09:01:25.000-0400`.
  const normalized = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseCnbcQuoteTime(quote) {
  // Some CNBC commodity quotes expose `last_time` as date-only while
  // `reg_last_time` has the actual intraday print. Prefer the precise field.
  // CNBC can also publish a future `last_time` on weekend commodity prints;
  // in that case the cache timestamp is safer for freshness classification.
  const lastTime = quote?.last_time ? String(quote.last_time) : '';
  const primary = lastTime && !lastTime.includes('T') && quote?.reg_last_time
    ? parseCnbcTime(quote.reg_last_time)
    : parseCnbcTime(quote?.last_time || quote?.reg_last_time || quote?.cachedTime);
  const cached = parseCnbcTime(quote?.cachedTime);
  if (primary && cached && primary.getTime() - Date.now() > 5 * 60 * 1000) return cached;
  return primary;
}
function marketStatus(q) {
  const raw = q?.curmktstatus || q?.marketStatus || '';
  if (/CLOS/i.test(q?.mainmktstatus || '')) return q.mainmktstatus;
  if (/CLOS|POST|PRE/i.test(raw)) return raw;
  return raw || q?.exchange || 'CNBC';
}

function getNewYorkParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type === 'weekday') acc.weekday = part.value;
    if (part.type === 'year') acc.year = Number(part.value);
    if (part.type === 'month') acc.month = Number(part.value);
    if (part.type === 'day') acc.day = Number(part.value);
    if (part.type === 'hour') acc.hour = Number(part.value);
    if (part.type === 'minute') acc.minute = Number(part.value);
    return acc;
  }, { weekday: '', year: 0, month: 0, day: 0, hour: 0, minute: 0 });
}

function isUsMemorialDay(parts) {
  // Last Monday in May. Add explicit holiday inference only where stale
  // provider prints would otherwise be misleading as live warnings.
  if (parts.month !== 5 || parts.weekday !== 'Mon') return false;
  return parts.day >= 25 && parts.day <= 31;
}

function observedIndependenceDayParts(year) {
  const july4 = getNewYorkParts(new Date(Date.UTC(year, 6, 4, 12, 0, 0)));
  if (july4.weekday === 'Sat') return { month: 7, day: 3 };
  if (july4.weekday === 'Sun') return { month: 7, day: 5 };
  return { month: 7, day: 4 };
}

function isUsIndependenceDayObserved(parts) {
  const observed = observedIndependenceDayParts(parts.year);
  return parts.month === observed.month && parts.day === observed.day;
}

function isUsIndependenceDayEarlyClose(parts) {
  // Bond markets commonly close early (around 14:00 ET) on the trading day
  // before Independence Day/observed Independence Day. CNBC can leave those
  // Tradeweb prints labeled REG_MKT, so classify stale post-early-close
  // Treasury quotes as closed instead of source warnings.
  const observed = observedIndependenceDayParts(parts.year);
  if (observed.month === 7 && observed.day === 3) return parts.month === 7 && parts.day === 2;
  if (observed.month === 7 && observed.day === 4) return parts.month === 7 && parts.day === 3;
  if (observed.month === 7 && observed.day === 5) return parts.month === 7 && parts.day === 2;
  return false;
}

function isTradewebTreasuryHolidayClose(metric, quote, ageSeconds, staleSeconds) {
  if (metric?.group !== 'Rates') return false;
  if (!/^US(2|10|30)Y$/i.test(metric?.symbol || '')) return false;
  if (!/Tradeweb/i.test(quote?.exchange || quote?.providerSymbol || '')) return false;
  if (ageSeconds === null || ageSeconds <= staleSeconds) return false;
  const etNow = getNewYorkParts(new Date());
  return isUsMemorialDay(etNow) || isUsIndependenceDayObserved(etNow) || isUsIndependenceDayEarlyClose(etNow);
}

function isTradewebTreasuryClose(metric, quote, tsDate, ageSeconds, staleSeconds) {
  if (metric?.group !== 'Rates') return false;
  if (!/^US(2|10|30)Y$/i.test(metric?.symbol || '')) return false;
  if (!/Tradeweb/i.test(quote?.exchange || quote?.providerSymbol || '')) return false;
  if (ageSeconds === null || ageSeconds <= staleSeconds) return false;
  if (!tsDate) return false;

  // CNBC can keep Tradeweb Treasury quotes labeled REG_MKT after the regular
  // around-17:00 ET close. Treat stale 17:00+ ET prints as closed, not warning.
  // Some tenors print at 17:04:xx while others print at 17:05:00 exactly.
  const et = getNewYorkParts(tsDate);
  return et.hour >= 17;
}

function isCnbcWeekendClose(metric, quote) {
  if (metric?.group === 'Commodity') return false;
  const etNow = getNewYorkParts(new Date());
  const isWeekend = etNow.weekday === 'Sat' || etNow.weekday === 'Sun';
  if (!isWeekend) return false;

  // Some CNBC quotes, notably DXY, can remain labeled REG_MKT through the
  // weekend even before they exceed the normal stale threshold. That is a
  // closed market, not live data.
  return /REG_MKT/i.test(quote?.curmktstatus || '') || !quote?.curmktstatus;
}

function isCmeCommodityQuote(metric, quote) {
  return metric?.group === 'Commodity'
    && /New York Mercantile Exchange|NYMEX|Commodities Exchange Centre|COMEX/i.test(quote?.exchange || '')
    && /^\/(CL|GC)/i.test(quote?.providerSymbol || '');
}

function isCmeCommodityWeekendClose(metric, quote) {
  if (!isCmeCommodityQuote(metric, quote)) return false;
  const etNow = getNewYorkParts(new Date());
  const minutes = etNow.hour * 60 + etNow.minute;
  // CME/NYMEX/COMEX commodity futures close for the weekend Friday evening
  // and CNBC can leave stale prints labeled REG_MKT through that window.
  if (etNow.weekday === 'Fri' && minutes >= 18 * 60) return true;
  return etNow.weekday === 'Sat' || etNow.weekday === 'Sun';
}

function isCmeCommodityHolidayClose(metric, quote, ageSeconds, staleSeconds) {
  if (!isCmeCommodityQuote(metric, quote)) return false;
  if (ageSeconds === null || ageSeconds <= staleSeconds) return false;
  return isUsMemorialDay(getNewYorkParts(new Date()));
}

function isCmeCommodityMaintenanceClose(metric, quote, tsDate, ageSeconds, staleSeconds) {
  if (!isCmeCommodityQuote(metric, quote)) return false;
  if (ageSeconds === null || ageSeconds <= staleSeconds) return false;
  if (!tsDate) return false;

  const etNow = getNewYorkParts(new Date());
  const etTick = getNewYorkParts(tsDate);
  const nowMinutes = etNow.hour * 60 + etNow.minute;
  const tickMinutes = etTick.hour * 60 + etTick.minute;

  // CNBC can keep CME/NYMEX/COMEX front-month commodity quotes labeled REG_MKT
  // through the short daily Globex maintenance window. Treat stale 16:55+ ET
  // prints during 17:00-18:00 ET as paused/closed, not source warnings.
  return nowMinutes >= 17 * 60 && nowMinutes < 18 * 60 && tickMinutes >= (16 * 60 + 55);
}

export async function fetchCnbcQuoteMetric(metric, { timeoutMs = 8000, staleSeconds = 86400 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=${encodeURIComponent(metric.symbol)}&output=json`;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 (stock-dashboard-mvp/0.1)', accept: 'application/json,text/plain,*/*' } });
    if (!res.ok) throw new Error(`CNBC HTTP ${res.status}`);
    const json = await res.json();
    const quote = json?.QuickQuoteResult?.QuickQuote?.[0];
    if (!quote || quote.last === undefined || quote.last === '') throw new Error('CNBC quote missing last value');

    const value = normalizeValue(quote.last, metric.scale ?? 1);
    if (value === null) throw new Error(`CNBC quote has non-numeric last value: ${quote.last}`);
    const change = normalizeValue(quote.change, metric.scale ?? 1);
    const changePct = normalizeValue(quote.change_pct, 1);
    const tsDate = parseCnbcQuoteTime(quote);
    const timestamp = tsDate ? tsDate.toISOString() : null;
    const ageSeconds = tsDate ? Math.max(0, Math.round((Date.now() - tsDate.getTime()) / 1000)) : null;
    const isClosed = /CLOS|POST/i.test(quote.curmktstatus || '') || /CLOS/i.test(quote.mainmktstatus || '');
    const isTreasuryHolidayClose = isTradewebTreasuryHolidayClose(metric, quote, ageSeconds, staleSeconds);
    const isTreasuryClose = isTradewebTreasuryClose(metric, quote, tsDate, ageSeconds, staleSeconds);
    const isWeekendClose = isCnbcWeekendClose(metric, quote);
    const isCommodityWeekendClose = isCmeCommodityWeekendClose(metric, quote);
    const isCommodityHolidayClose = isCmeCommodityHolidayClose(metric, quote, ageSeconds, staleSeconds);
    const isCommodityMaintenanceClose = isCmeCommodityMaintenanceClose(metric, quote, tsDate, ageSeconds, staleSeconds);
    const inferredClosedMessage = isTreasuryHolidayClose
      ? `Tradeweb Treasury US holiday/closed-market print; CNBC quote is ${ageSeconds}s old`
      : isTreasuryClose
        ? `Tradeweb Treasury post-close print; CNBC quote is ${ageSeconds}s old`
        : isWeekendClose
          ? `CNBC weekend/closed-market print; quote is ${ageSeconds}s old`
          : isCommodityWeekendClose
            ? `CME commodity weekend/closed-market print; CNBC quote is ${ageSeconds}s old`
            : isCommodityHolidayClose
              ? `CME commodity US holiday/closed-market print; CNBC quote is ${ageSeconds}s old`
              : isCommodityMaintenanceClose
                ? `CME commodity maintenance/closed-market print; CNBC quote is ${ageSeconds}s old`
                : undefined;
    const state = isClosed || isTreasuryHolidayClose || isTreasuryClose || isWeekendClose || isCommodityWeekendClose || isCommodityHolidayClose || isCommodityMaintenanceClose
      ? closedStatus({
          marketState: isTreasuryHolidayClose ? 'Tradeweb US holiday close inferred' : isTreasuryClose ? 'Tradeweb close inferred' : isWeekendClose ? 'CNBC weekend close inferred' : isCommodityWeekendClose ? 'CME commodity weekend close inferred' : isCommodityHolidayClose ? 'CME commodity US holiday close inferred' : isCommodityMaintenanceClose ? 'CME commodity maintenance close inferred' : marketStatus(quote),
          ageSeconds,
          message: inferredClosedMessage
        })
      : ageSeconds !== null && ageSeconds > staleSeconds
        ? delayedStatus({ marketState: marketStatus(quote), ageSeconds, message: `CNBC quote is ${ageSeconds}s old` })
        : okStatus({ marketState: marketStatus(quote), ageSeconds, message: `${quote.name || quote.shortName || metric.name}; ${quote.exchange || 'CNBC'}` });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'cnbc',
      symbol: metric.symbol,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value,
      change,
      changePct,
      timestamp,
      fetchedAt: new Date().toISOString(),
      status: state,
      delayNote: metric.delayNote || null,
      sourceUrl: url,
      rawName: quote.name || quote.shortName || null,
      providerSymbol: quote.providerSymbol || null
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'CNBC timeout' : err.message;
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'cnbc',
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
