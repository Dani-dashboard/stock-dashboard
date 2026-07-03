import { delayedStatus, failedStatus } from '../status.mjs';

const KOSPI_NIGHT_URL = 'https://chartlog.net/stats/market-index/kospi-night-futures/';

export async function fetchChartlogKospiNightFuturesMetric(metric, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(KOSPI_NIGHT_URL, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 stock-dashboard/0.1',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`Chartlog HTTP ${res.status}`);
    const html = await res.text();
    const quote = parseKospiNightFuturesHtml(html);
    if (quote.value === null) throw new Error('Chartlog page parsed but current price missing');
    return {
      ...metric,
      provider: 'chartlog',
      symbol: metric.symbol || 'kospi-night-futures',
      value: quote.value,
      change: quote.change,
      changePct: quote.changePct,
      volume: quote.volume,
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      sourceUrl: KOSPI_NIGHT_URL,
      displayNote: `${metric.displayNote || ''} Chartlog 야간선물 페이지를 대체 소스로 사용. KIS 공식 웹소켓 tick 미수신 시에만 참고하며, 원천/지연 가능성을 상태 메시지로 표시.`,
      status: delayedStatus({
        label: quote.marketLabel || '대체소스',
        marketState: 'CHARTLOG_NIGHT_FUTURES',
        message: `Chartlog scraped fallback; ${quote.marketLabel || 'status unknown'}; prev settlement ${formatMaybe(quote.prevSettlement)}, open ${formatMaybe(quote.open)}, high ${formatMaybe(quote.high)}, low ${formatMaybe(quote.low)}`
      }),
      raw: {
        marketLabel: quote.marketLabel,
        prevSettlement: quote.prevSettlement,
        open: quote.open,
        high: quote.high,
        low: quote.low
      }
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Chartlog timeout' : err.message;
    return {
      ...metric,
      provider: 'chartlog',
      value: null,
      change: null,
      changePct: null,
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      sourceUrl: KOSPI_NIGHT_URL,
      status: failedStatus(message)
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseKospiNightFuturesHtml(html) {
  const compact = String(html).replace(/<!--\s*-->/g, '').replace(/\s+/g, ' ');
  const marketLabel = textMatch(compact, /rounded-full[^>]*><span[^>]*><\/span>([^<]+)<\/span>/);
  const headerMatch = compact.match(/tabular-nums">([\d,.]+)<\/span><span[^>]*>(▲|▼)?\s*([\d,.+-]+)\s*\(([-+]?\d+(?:\.\d+)?)%\)<\/span><span[^>]*>거래량\s*([\d,]+)/);
  const value = headerMatch ? numberOrNull(headerMatch[1]) : null;
  const arrow = headerMatch?.[2] || '';
  const rawChange = headerMatch ? numberOrNull(headerMatch[3]) : null;
  const rawPct = headerMatch ? numberOrNull(headerMatch[4]) : null;
  const sign = arrow === '▼' ? -1 : 1;
  const change = rawChange === null ? null : Math.abs(rawChange) * sign;
  const changePct = rawPct === null ? null : Math.abs(rawPct) * sign;
  const volume = headerMatch ? numberOrNull(headerMatch[5]) : null;
  return {
    marketLabel: marketLabel || null,
    value,
    change,
    changePct,
    volume,
    prevSettlement: labeledNumber(compact, '전일 정산가'),
    open: labeledNumber(compact, '야간 시가'),
    high: labeledNumber(compact, '야간 고가'),
    low: labeledNumber(compact, '야간 저가')
  };
}

function labeledNumber(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}<\\/span><span[^>]*>([-+\\d,.]+)%?<\\/span>`);
  return numberOrNull(text.match(re)?.[1]);
}

function textMatch(text, re) {
  return text.match(re)?.[1]?.trim() || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function formatMaybe(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('ko-KR');
}
