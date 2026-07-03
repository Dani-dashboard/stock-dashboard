import { closedStatus } from './status.mjs';

export function isMarketOpen(market, now = new Date()) {
  if (!market) return true;
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  const weekday = kst.weekday; // 1 Mon ... 7 Sun
  const isWeekday = weekday >= 1 && weekday <= 5;
  if (!isWeekday) return false;

  const dateKey = kst.date;

  if ((market === 'kr_derivatives_day' || market === 'kr_cash_day') && isKrxTradingHoliday(dateKey)) {
    return false;
  }

  if (market === 'kr_derivatives_day') {
    return minutes >= (8 * 60 + 45) && minutes <= (15 * 60 + 45);
  }
  if (market === 'kr_cash_day') {
    return minutes >= (9 * 60) && minutes <= (15 * 60 + 30);
  }
  // KRX night futures exact product/session rules can vary; keep conservative until confirmed.
  if (market === 'kr_derivatives_night') {
    // Night futures run weekday evenings into the next early morning.
    // Monday before 05:00 KST would require a Sunday night session, so keep it closed.
    if (weekday === 1 && minutes <= (5 * 60)) return false;
    const ctx = krxNightSessionContext(now);
    // If either the evening start date or the Korea cash-session handoff date is a KRX holiday,
    // do not treat the stale/reference night-futures value as a fresh tradable session.
    if (ctx && (isKrxTradingHoliday(ctx.sessionStartDate) || isKrxTradingHoliday(ctx.cashHandoffDate))) return false;
    return minutes >= (18 * 60) || minutes <= (5 * 60);
  }
  return true;
}

export function isKrxTradingHoliday(dateKey) {
  return Boolean(KRX_TRADING_HOLIDAYS[dateKey]);
}

export function krxHolidayName(dateKey) {
  return KRX_TRADING_HOLIDAYS[dateKey] || null;
}

export function wasLatestKrxNightSessionHolidayClosed(now = new Date()) {
  const ctx = krxNightSessionContext(now);
  if (!ctx) return false;
  return isKrxTradingHoliday(ctx.sessionStartDate) || isKrxTradingHoliday(ctx.cashHandoffDate);
}

export function latestKrxNightSessionHolidayReason(now = new Date()) {
  const ctx = krxNightSessionContext(now);
  if (!ctx) return null;
  const startHoliday = krxHolidayName(ctx.sessionStartDate);
  if (startHoliday) return `${ctx.sessionStartDate} ${startHoliday}`;
  const handoffHoliday = krxHolidayName(ctx.cashHandoffDate);
  if (handoffHoliday) return `${ctx.cashHandoffDate} ${handoffHoliday}`;
  return null;
}

export function closedMarketMetric(metric, market) {
  return {
    id: metric.id,
    name: metric.name,
    group: metric.group,
    groupOrder: metric.groupOrder,
    groupLabel: metric.groupLabel,
    groupDescription: metric.groupDescription,
    provider: metric.provider,
    symbol: metric.symbol,
    unit: metric.unit || '',
    decimals: metric.decimals,
    displayNote: metric.displayNote || null,
    value: null,
    change: null,
    changePct: null,
    timestamp: null,
    fetchedAt: new Date().toISOString(),
    status: closedStatus({ marketState: `${market}_CLOSED`, message: 'market-hours policy skipped API call' }),
    sourceUrl: null
  };
}

function partsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { weekday: weekdayMap[parts.weekday], hour: Number(parts.hour), minute: Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
}

function krxNightSessionContext(now) {
  const kst = partsInTimeZone(now, 'Asia/Seoul');
  const minutes = kst.hour * 60 + kst.minute;
  if (minutes >= 18 * 60) {
    return { sessionStartDate: kst.date, cashHandoffDate: addDays(kst.date, 1) };
  }
  if (minutes <= 9 * 60) {
    return { sessionStartDate: addDays(kst.date, -1), cashHandoffDate: kst.date };
  }
  return null;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const KRX_TRADING_HOLIDAYS = {
  // Keep this small and explicit: only confirmed KRX closures used by source/status policy.
  // 2026-06-03: Korea local election day; cash market and KRX night derivatives closed.
  '2026-06-03': '전국동시지방선거 휴장'
};
