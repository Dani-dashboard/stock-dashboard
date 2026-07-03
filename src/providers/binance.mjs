import { failedStatus, normalizeValue, okStatus, delayedStatus } from '../status.mjs';

export async function fetchBinanceMetric(metric, { timeoutMs = 8000, staleSeconds = 180 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(metric.symbol)}`;

  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'stock-dashboard-mvp/0.1' } });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const json = await res.json();
    const value = normalizeValue(json.lastPrice, metric.scale ?? 1);
    if (value === null) throw new Error('Binance has no lastPrice');

    const ts = json.closeTime ? new Date(json.closeTime).toISOString() : null;
    const ageSeconds = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 1000) : null;
    const state = ageSeconds !== null && ageSeconds > staleSeconds
      ? delayedStatus({ marketState: '24H', ageSeconds, message: `latest tick is ${ageSeconds}s old` })
      : okStatus({ marketState: '24H', ageSeconds });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'binance',
      symbol: metric.symbol,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value,
      change: normalizeValue(json.priceChange, metric.scale ?? 1),
      changePct: normalizeValue(json.priceChangePercent, 1),
      timestamp: ts,
      fetchedAt: new Date().toISOString(),
      status: state,
      delayNote: metric.delayNote || null,
      sourceUrl: url
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Binance timeout' : err.message;
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'binance',
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
