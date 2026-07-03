import { failedStatus, normalizeValue, okStatus, delayedStatus } from '../status.mjs';

function parseFredCsv(text, seriesId, scale = 1) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('FRED CSV has no observations');

  const observations = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    const value = normalizeValue(raw, scale);
    if (!date || value === null) continue;
    observations.push({ date, value });
  }
  if (!observations.length) throw new Error(`FRED ${seriesId} has no numeric observations`);
  return observations;
}

export async function fetchFredMetric(metric, { timeoutMs = 8000, staleSeconds = 604800 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const seriesId = metric.seriesId || metric.symbol;
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'stock-dashboard-mvp/0.1', accept: 'text/csv,text/plain,*/*' }
    });
    if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
    const text = await res.text();
    const observations = parseFredCsv(text, seriesId, metric.scale ?? 1);
    const latest = observations.at(-1);
    const previous = observations.length >= 2 ? observations.at(-2) : null;
    const timestamp = new Date(`${latest.date}T21:00:00-05:00`).toISOString();
    const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
    const change = previous ? latest.value - previous.value : null;
    const changePct = previous?.value ? (change / previous.value) * 100 : null;
    const status = ageSeconds > staleSeconds
      ? delayedStatus({ marketState: 'FRED_DAILY', ageSeconds, message: `latest FRED observation ${latest.date} is ${ageSeconds}s old` })
      : okStatus({ marketState: 'FRED_DAILY', ageSeconds, message: `latest FRED observation ${latest.date}` });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'fred',
      symbol: seriesId,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: latest.value,
      change,
      changePct,
      timestamp,
      fetchedAt: new Date().toISOString(),
      status,
      delayNote: metric.delayNote || null,
      sourceUrl: url,
      raw: {
        observationDate: latest.date,
        previousObservationDate: previous?.date || null,
        previousValue: previous?.value ?? null
      }
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'FRED timeout' : err.message;
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'fred',
      symbol: seriesId,
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
