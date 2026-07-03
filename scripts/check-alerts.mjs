import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const latestPath = path.join(root, 'data/latest.json');
const statePath = path.join(root, 'data/alert-state.json');
const outPath = path.join(root, 'data/alerts-latest.json');

await loadEnvFile(path.join(root, '.env.alerts'));
const cooldownMs = Number(process.env.ALERT_COOLDOWN_MS || 30 * 60 * 1000);
const emailEnabled = process.env.ALERT_EMAIL_ENABLED === '1';
const emailProvider = process.env.ALERT_EMAIL_PROVIDER || 'sendmail';
const emailFallbackProvider = process.env.ALERT_EMAIL_FALLBACK_PROVIDER || '';
const emailWindow = process.env.ALERT_EMAIL_WINDOW || 'manual';
const emailTo = process.env.ALERT_EMAIL_TO || 'hummingscape@gmail.com';
const emailFrom = process.env.ALERT_EMAIL_FROM || 'stock-dashboard-alert@localhost';
const telegramEnabled = process.env.TELEGRAM_ALERT_ENABLED === '1';
const telegramAccount = process.env.TELEGRAM_ALERT_ACCOUNT || 'default';
const telegramTarget = process.env.TELEGRAM_ALERT_TARGET || '8518699807';
const now = process.env.ALERT_NOW_ISO ? new Date(process.env.ALERT_NOW_ISO) : new Date();
const emailWindowState = evaluateEmailWindow(now, emailWindow);
const latest = JSON.parse(await fs.readFile(latestPath, 'utf8'));
const state = await readJson(statePath, { observations: [], lastAlerts: {} });

const observation = buildObservation(latest, now.toISOString());
state.observations = [...(state.observations || []), observation]
  .filter(o => now - new Date(o.at) <= 3 * 60 * 60 * 1000)
  .slice(-240);

const candidates = buildCandidates(latest, state, observation);
const alertCandidates = candidates.map(candidate => applyCooldown(candidate, state, now));
for (const alert of alertCandidates.filter(a => a.wouldSend)) {
  const wantsEmail = !alert.channels || alert.channels.includes('email');
  const wantsTelegram = alert.channels?.includes('telegram');
  const emailWindowOk = alert.bypassEmailWindow || emailWindowState.active;
  if (wantsEmail && emailEnabled && emailWindowOk) {
    try {
      await sendEmail({ to: emailTo, from: emailFrom, subject: alert.subject });
      alert.emailSent = true;
      alert.emailError = null;
    } catch (err) {
      alert.emailSent = false;
      alert.emailError = err.message;
    }
  } else {
    alert.emailSent = false;
    alert.emailError = wantsEmail ? (emailEnabled ? `email window inactive: ${emailWindowState.reason}` : 'email disabled') : null;
  }

  if (wantsTelegram && telegramEnabled) {
    try {
      await sendTelegramAlert(alert);
      alert.telegramSent = true;
      alert.telegramError = null;
    } catch (err) {
      alert.telegramSent = false;
      alert.telegramError = err.message;
    }
  } else {
    alert.telegramSent = false;
    alert.telegramError = wantsTelegram ? 'telegram disabled' : null;
  }

  alert.sent = Boolean(alert.emailSent || alert.telegramSent);
  alert.sendError = [alert.emailError, alert.telegramError].filter(Boolean).join('; ') || null;
  if (alert.sent) {
    state.lastAlerts[alert.key] = {
      at: now.toISOString(),
      subject: alert.subject,
      severity: alert.severity,
      value: alert.value ?? null,
      sent: true,
      emailSent: Boolean(alert.emailSent),
      telegramSent: Boolean(alert.telegramSent),
      sendError: alert.sendError
    };
  }
}

const payload = {
  generatedAt: now.toISOString(),
  mode: emailEnabled ? emailProvider : 'dry-run',
  fallbackMode: emailFallbackProvider || null,
  destination: emailTo,
  emailEnabled,
  telegramEnabled,
  emailWindow,
  emailWindowActive: emailWindowState.active,
  emailWindowReason: emailWindowState.reason,
  policy: {
    cooldownMinutes: Math.round(cooldownMs / 60000),
    usdkrw: {
      supportResistanceBreak: true,
      move30mPct: 0.50,
      otherEmailTriggers: false
    },
    kospi: {
      move1mPct: 1.00,
      move5mEmail: false,
      intradayEmail: false
    },
    kospi200FuturesPriceMove: {
      emailExcluded: true
    },
    kospi200FuturesForeignFlow: {
      move30mBillionKrw: 1000
    },
    kospiCashForeignFlow: {
      move30mBillionKrw: 1000
    },
    koreaMarketSafety: {
      sidecarKospi200FuturesPct: 5.00,
      circuitBreakerKospiKosdaqDownPct: 8.00,
      channels: ['email', 'telegram'],
      todayIssueTtlMinutes: 60
    }
  },
  candidates: alertCandidates,
  wouldSend: alertCandidates.filter(a => a.wouldSend).map(({ subject, reason, key }) => ({ subject, reason, key })),
  notes: [
    emailEnabled ? `Email sending was enabled via ALERT_EMAIL_ENABLED=1; window=${emailWindow}; active=${emailWindowState.active}.` : 'Dry-run only: no email was sent.',
    'Gmail API sending is approved/configured; recurring sends are controlled by time window and cooldown.'
  ]
};

await fs.writeFile(statePath, JSON.stringify(state, null, 2));
await fs.writeFile(outPath, JSON.stringify(payload, null, 2));
console.log(`alerts ${emailEnabled ? payload.mode : 'dry-run'}: ${payload.candidates.length} candidate(s), ${payload.wouldSend.length} would-send, window=${emailWindowState.active ? 'active' : 'inactive'}`);
for (const item of payload.wouldSend) console.log(`${emailEnabled && emailWindowState.active ? 'SEND ATTEMPT' : 'WOULD SEND'}: ${item.subject}`);

function buildObservation(data, at) {
  const usdkrw = data.metrics?.find(m => m.id === 'usdkrw');
  const kospi = data.metrics?.find(m => m.id === 'kospi');
  const kospi200 = data.metrics?.find(m => m.id === 'kospi200');
  const dayFutures = data.metrics?.find(m => m.id === 'kospi200_futures_kis');
  const nightFutures = data.metrics?.find(m => m.id === 'kospi200_night_futures_kis');
  const kospi200Flow = data.investorFlows?.find(f => f.id === 'kospi200_futures');
  const kospiCashFlow = data.investorFlows?.find(f => f.id === 'kospi_cash');
  const flowEligible = isKrxFuturesInvestorFlowEligible(kospi200Flow, at);
  return {
    at,
    usdkrw: {
      value: numberOrNull(usdkrw?.value),
      changePct: numberOrNull(usdkrw?.changePct)
    },
    kospi: marketObservation(kospi),
    kospi200: marketObservation(kospi200),
    kospi200Futures: marketObservation(dayFutures),
    kospi200NightFutures: marketObservation(nightFutures),
    kospi200FuturesForeign: {
      netBuy: flowEligible ? numberOrNull(kospi200Flow?.foreignNetBuy) : null,
      buy: flowEligible ? numberOrNull(kospi200Flow?.foreignBuy) : null,
      sell: flowEligible ? numberOrNull(kospi200Flow?.foreignSell) : null
    },
    kospiCashForeign: {
      netBuy: flowEligible ? numberOrNull(kospiCashFlow?.foreignNetBuy) : null,
      buy: flowEligible ? numberOrNull(kospiCashFlow?.foreignBuy) : null,
      sell: flowEligible ? numberOrNull(kospiCashFlow?.foreignSell) : null
    }
  };
}

function buildCandidates(data, state, obs) {
  const candidates = [];
  const usdkrw = data.metrics?.find(m => m.id === 'usdkrw');
  const usdLevel = data.fxLevels?.find(x => x.id === 'usdkrw');
  const previous1m = nearestObservation(state.observations || [], obs.at, 60 * 1000, { minRatio: 0.5, maxRatio: 2.5 });
  const previous30m = nearestObservation(state.observations || [], obs.at, 30 * 60 * 1000);

  addKoreaMarketSafetyCandidates(candidates, data, obs.at);

  if (usdkrw && usdLevel) {
    if (usdLevel.status === 'below_support') {
      candidates.push({
        key: 'usdkrw-support-break',
        severity: 'High',
        subject: `[시장알림] USD/KRW 5일 지지선 하향 이탈 — 원화 강세 / 달러 약세`,
        reason: `USD/KRW ${fmt(usdkrw.value)} < 5일 지지 ${fmt(usdLevel.support)}`,
        value: usdkrw.value
      });
    }
    if (usdLevel.status === 'above_resistance') {
      candidates.push({
        key: 'usdkrw-resistance-break',
        severity: 'High',
        subject: `[시장알림] USD/KRW 5일 저항선 상향 돌파 — 원화 약세 / 달러 강세`,
        reason: `USD/KRW ${fmt(usdkrw.value)} > 5일 저항 ${fmt(usdLevel.resistance)}`,
        value: usdkrw.value
      });
    }
  }

  addIndexMoveCandidates(candidates, {
    id: 'kospi',
    label: 'KOSPI',
    obs: obs.kospi,
    previous1m: previous1m?.kospi,
    previous5m: null,
    tradeWindow: isKoreaCashWindow(obs.at),
    threshold1m: 1.00,
    threshold5m: Infinity,
    thresholdIntraday: Infinity,
    valueSuffix: 'pt'
  });

  addIndexMoveCandidates(candidates, {
    id: 'kospi200',
    label: 'KOSPI200',
    obs: obs.kospi200,
    previous1m: previous1m?.kospi200,
    previous5m: null,
    tradeWindow: isKoreaCashWindow(obs.at),
    threshold1m: 1.00,
    threshold5m: Infinity,
    thresholdIntraday: Infinity,
    valueSuffix: 'pt'
  });

  if (previous30m?.usdkrw?.value && obs.usdkrw.value) {
    const move30mPct = ((obs.usdkrw.value - previous30m.usdkrw.value) / previous30m.usdkrw.value) * 100;
    if (Math.abs(move30mPct) >= 0.50) {
      const down = move30mPct < 0;
      candidates.push({
        key: `usdkrw-30m-${down ? 'down' : 'up'}`,
        severity: 'High',
        subject: `[시장알림] USD/KRW 30분 ${signed(move30mPct)}% ${down ? '급락 — 원화 강세 가속' : '급등 — 원화 약세 압력'}`,
        reason: `USD/KRW ${fmt(previous30m.usdkrw.value)} → ${fmt(obs.usdkrw.value)} in ~30m`,
        value: move30mPct
      });
    }
  }

  if (previous30m?.kospi200FuturesForeign?.netBuy !== null && previous30m?.kospi200FuturesForeign?.netBuy !== undefined && obs.kospi200FuturesForeign.netBuy !== null) {
    const prev = previous30m.kospi200FuturesForeign.netBuy;
    const cur = obs.kospi200FuturesForeign.netBuy;
    const diff = cur - prev;
    if (Math.abs(diff) >= 1000) {
      candidates.push({
        key: `k200f-foreign-30m-${diff > 0 ? 'improve' : 'worsen'}`,
        severity: 'High',
        subject: `[시장알림] 외국인 KOSPI200 선물 30분 순매수 ${signed(diff, 0)}십억원 변화 — ${diff > 0 ? '수급 개선' : '수급 악화'}`,
        reason: `foreign KOSPI200 futures net ${signed(prev, 0)} → ${signed(cur, 0)}십억원`,
        value: diff
      });
    }
  }

  addFlowCandidates(candidates, {
    id: 'kospi-cash-foreign',
    label: '외국인 KOSPI 현물',
    current: obs.kospiCashForeign?.netBuy,
    prev1m: null,
    prev30m: previous30m?.kospiCashForeign?.netBuy,
    oneMinuteThreshold: Infinity,
    thirtyMinuteThreshold: 1000,
    extremeThreshold: Infinity
  });

  return candidates;
}

function addKoreaMarketSafetyCandidates(candidates, data, nowIso) {
  for (const event of data.officialMarketSafetyEvents || []) {
    if (event.type === 'sidecar') {
      const directionLabel = event.direction === 'buy' ? '매수' : event.direction === 'sell' ? '매도' : '방향 미확인';
      candidates.push({
        key: event.id,
        once: true,
        severity: 'Critical',
        channels: ['email', 'telegram'],
        bypassEmailWindow: true,
        subject: `[긴급 시장안전장치] KRX 공식 KOSPI 사이드카 ${directionLabel} 확인`,
        reason: `${event.source}: ${event.title}`,
        value: null,
        officialSourceUrl: event.url || null
      });
    }

    if (event.type === 'circuit-breaker') {
      const marketLabel = event.market === 'kosdaq' ? 'KOSDAQ' : event.market === 'kospi' ? 'KOSPI' : '시장';
      candidates.push({
        key: event.id,
        once: true,
        severity: 'Critical',
        channels: ['email', 'telegram'],
        bypassEmailWindow: true,
        subject: `[긴급 시장안전장치] KRX 공식 ${marketLabel} 서킷브레이커 ${event.level} 확인`,
        reason: `${event.source}: ${event.title}`,
        value: null,
        officialSourceUrl: event.url || null
      });
    }
  }

  // Threshold-only sidecar/circuit-breaker watches are rendered in the dashboard by fetch-all.mjs.
  // Email/Telegram urgent alerts are intentionally reserved for official KRX market-operation notices.
}

function applyCooldown(candidate, state, now) {
  const last = state.lastAlerts?.[candidate.key];
  const cooldownActive = last && now - new Date(last.at) < cooldownMs;
  const onceAlreadySent = Boolean(candidate.once && last?.sent);
  return {
    ...candidate,
    wouldSend: !cooldownActive && !onceAlreadySent,
    emailEnabled,
    cooldownActive: Boolean(cooldownActive),
    onceAlreadySent,
    lastSentAt: last?.at || null
  };
}

function marketObservation(metric) {
  if (!metric) return { value: null, changePct: null, statusLevel: null };
  return {
    value: numberOrNull(metric.value),
    changePct: numberOrNull(metric.changePct),
    statusLevel: metric.status?.level || null
  };
}

function addIndexMoveCandidates(candidates, options) {
  const {
    id,
    label,
    obs,
    previous1m,
    previous5m,
    tradeWindow,
    threshold1m,
    threshold5m,
    thresholdIntraday,
    valueSuffix
  } = options;
  if (!tradeWindow || obs?.statusLevel !== 'ok' || obs.value === null) return;

  if (previous1m?.value) {
    const move1mPct = pctMove(previous1m.value, obs.value);
    if (Math.abs(move1mPct) >= threshold1m) {
      const up = move1mPct > 0;
      candidates.push({
        key: `${id}-1m-${up ? 'up' : 'down'}`,
        severity: 'Urgent',
        subject: `[시장알림] ${label} 1분 ${signed(move1mPct)}% ${up ? '급등 — 상방 변동성 확대' : '급락 — 하방 변동성 확대'}`,
        reason: `${label} ${fmt(previous1m.value)} → ${fmt(obs.value)}${valueSuffix ? valueSuffix : ''} in ~1m`,
        value: move1mPct
      });
    }
  }

  if (previous5m?.value) {
    const move5mPct = pctMove(previous5m.value, obs.value);
    if (Math.abs(move5mPct) >= threshold5m) {
      const up = move5mPct > 0;
      candidates.push({
        key: `${id}-5m-${up ? 'up' : 'down'}`,
        severity: 'High',
        subject: `[시장알림] ${label} 5분 ${signed(move5mPct)}% ${up ? '급등 — 추세 변동성 확대' : '급락 — 위험회피 확대'}`,
        reason: `${label} ${fmt(previous5m.value)} → ${fmt(obs.value)}${valueSuffix ? valueSuffix : ''} in ~5m`,
        value: move5mPct
      });
    }
  }

  if (obs.changePct !== null && Math.abs(obs.changePct) >= thresholdIntraday) {
    const up = obs.changePct > 0;
    candidates.push({
      key: `${id}-intraday-${up ? 'up' : 'down'}`,
      severity: 'High',
      subject: `[시장알림] ${label} 당일 ${signed(obs.changePct)}% ${up ? '급등 — 시장 방향성 강함' : '급락 — 시장 스트레스 확대'}`,
      reason: `${label} ${fmt(obs.value)}${valueSuffix ? valueSuffix : ''}, intraday ${signed(obs.changePct)}%`,
      value: obs.changePct
    });
  }
}

function addFlowCandidates(candidates, options) {
  const { id, label, current, prev1m, prev30m, oneMinuteThreshold, thirtyMinuteThreshold, extremeThreshold, signFlipThreshold = Infinity } = options;
  if (current === null || current === undefined) return;
  const cur = Number(current);
  if (!Number.isFinite(cur)) return;

  if (Math.abs(cur) >= extremeThreshold) {
    candidates.push({
      key: `${id}-extreme-${cur > 0 ? 'buy' : 'sell'}`,
      severity: 'High',
      subject: `[시장알림] ${label} ${cur > 0 ? '순매수' : '순매도'} ${signed(cur, 0)}십억원 — ${cur > 0 ? '현물 수급 우호' : '현물 수급 부담 확대'}`,
      reason: `${label} net ${signed(cur, 0)}십억원`,
      value: cur
    });
  }

  if (prev1m !== null && prev1m !== undefined) {
    const prev = Number(prev1m);
    const diff = cur - prev;
    if (Number.isFinite(prev) && Math.abs(diff) >= oneMinuteThreshold) {
      candidates.push({
        key: `${id}-1m-${diff > 0 ? 'improve' : 'worsen'}`,
        severity: 'Urgent',
        subject: `[시장알림] ${label} 1분 순매수 ${signed(diff, 0)}십억원 변화 — ${diff > 0 ? '수급 급개선' : '수급 급악화'}`,
        reason: `${label} net ${signed(prev, 0)} → ${signed(cur, 0)}십억원`,
        value: diff
      });
    }
  }

  if (prev30m !== null && prev30m !== undefined) {
    const prev = Number(prev30m);
    const diff = cur - prev;
    const flipped = Math.sign(prev) !== 0 && Math.sign(cur) !== 0 && Math.sign(prev) !== Math.sign(cur);
    if (Number.isFinite(prev) && Number.isFinite(signFlipThreshold) && flipped && Math.abs(diff) >= signFlipThreshold) {
      candidates.push({
        key: `${id}-flip-${cur > 0 ? 'buy' : 'sell'}`,
        severity: 'High',
        subject: `[시장알림] ${label} ${prev > 0 ? '순매수→순매도' : '순매도→순매수'} 전환 — ${cur > 0 ? '수급 개선' : '수급 부담'}`,
        reason: `${label} net ${signed(prev, 0)} → ${signed(cur, 0)}십억원`,
        value: cur
      });
    }
    if (Number.isFinite(prev) && Math.abs(diff) >= thirtyMinuteThreshold) {
      candidates.push({
        key: `${id}-30m-${diff > 0 ? 'improve' : 'worsen'}`,
        severity: 'High',
        subject: `[시장알림] ${label} 30분 순매수 ${signed(diff, 0)}십억원 변화 — ${diff > 0 ? '수급 개선' : '수급 악화'}`,
        reason: `${label} net ${signed(prev, 0)} → ${signed(cur, 0)}십억원`,
        value: diff
      });
    }
  }
}

function nearestObservation(observations, nowIso, targetMs, options = {}) {
  const minRatio = options.minRatio ?? 0.75;
  const maxRatio = options.maxRatio ?? Infinity;
  const nowMs = new Date(nowIso).getTime();
  const candidates = observations
    .filter(o => {
      const age = nowMs - new Date(o.at).getTime();
      return age >= targetMs * minRatio && age <= targetMs * maxRatio;
    })
    .map(o => ({ o, delta: Math.abs((nowMs - new Date(o.at).getTime()) - targetMs) }))
    .sort((a, b) => a.delta - b.delta);
  return candidates[0]?.o || null;
}

function pctMove(previous, current) {
  const prev = Number(previous);
  const cur = Number(current);
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) return 0;
  return ((cur - prev) / prev) * 100;
}

function isKrxFuturesInvestorFlowEligible(flow, nowIso = new Date().toISOString()) {
  if (!flow || flow.status !== 'ok') return false;
  if (!isKoreaDayFuturesWindow(nowIso)) return false;
  if (!flow.tradeDate) return false;
  return String(flow.tradeDate).replace(/\D/g, '') === formatKstDateCompact(new Date(nowIso));
}

function isKoreaDayFuturesWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const minutes = kstMinutes(now);
  return minutes >= 8 * 60 + 45 && minutes < 15 * 60 + 45;
}

function isKoreaCashWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const minutes = kstMinutes(now);
  return minutes >= 8 * 60 + 50 && minutes <= 15 * 60 + 35;
}

function isKoreaNightFuturesWindow(nowIso = new Date().toISOString()) {
  const now = nowIso instanceof Date ? nowIso : new Date(nowIso);
  const minutes = kstMinutes(now);
  return minutes >= 18 * 60 || minutes <= 6 * 60;
}

function kstMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function formatKstDateCompact(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date).replace(/-/g, '');
}

function evaluateEmailWindow(at, windowName) {
  if (windowName === 'always') return { active: true, reason: 'always' };
  if (windowName === 'manual' || !windowName) return { active: true, reason: 'manual opt-in' };
  if (windowName !== 'major-market-hours') return { active: false, reason: `unknown window ${windowName}` };

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(at).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const weekday = parts.weekday;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekdayIndex = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[weekday];
  const isWeekday = weekdayIndex >= 1 && weekdayIndex <= 5;
  const isTueToSat = weekdayIndex >= 2 && weekdayIndex <= 6;
  const koreaSession = isWeekday && minutes >= 8 * 60 + 30 && minutes <= 16 * 60;
  const usEveningSession = isWeekday && minutes >= 21 * 60;
  const usOvernightSession = isTueToSat && minutes <= 6 * 60 + 30;
  if (koreaSession) return { active: true, reason: 'Korea market window 08:30-16:00 KST' };
  if (usEveningSession || usOvernightSession) return { active: true, reason: 'US market/event window 21:00-06:30 KST' };
  return { active: false, reason: 'outside major Korea/US market windows' };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function loadEnvFile(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmt(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function signed(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(decimals)}`;
}

async function sendEmail({ to, from, subject }) {
  try {
    return await sendEmailVia(emailProvider, { to, from, subject });
  } catch (err) {
    if (!emailFallbackProvider || emailFallbackProvider === emailProvider) throw err;
    try {
      await sendEmailVia(emailFallbackProvider, { to, from, subject });
      return;
    } catch (fallbackErr) {
      throw new Error(`${emailProvider} failed: ${err.message}; fallback ${emailFallbackProvider} failed: ${fallbackErr.message}`);
    }
  }
}

function sendTelegramAlert(alert) {
  const message = [
    alert.subject,
    alert.reason ? `근거: ${alert.reason}` : null,
    '채널: 긴급 시장안전장치 알림'
  ].filter(Boolean).join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn('openclaw', [
      'message', 'send',
      '--channel', 'telegram',
      '--account', telegramAccount,
      '--target', telegramTarget,
      '--message', message,
      '--json'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`openclaw message send exited ${code}: ${stderr.trim()}`));
    });
  });
}

function sendEmailVia(provider, { to, from, subject }) {
  if (provider === 'gmail-api') return sendGmailApi({ to, from, subject });
  if (provider === 'gmail-smtp') return sendGmailSmtp({ to, from, subject });
  const message = [
    `To: ${sanitizeHeader(to)}`,
    `From: ${sanitizeHeader(from)}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
    ''
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn('/usr/sbin/sendmail', ['-t'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`sendmail exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(message);
    child.stdin.end();
  });
}

async function sendGmailApi({ to, from, subject }) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://127.0.0.1:8789/oauth2callback';
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Missing Gmail API credentials');
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });
  const message = [
    `To: ${sanitizeHeader(to)}`,
    `From: ${sanitizeHeader(from)}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
    ''
  ].join('\r\n');
  const raw = Buffer.from(message, 'utf8').toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

async function sendGmailSmtp({ to, from, subject }) {
  const user = process.env.ALERT_EMAIL_USER;
  const pass = process.env.ALERT_EMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('Missing ALERT_EMAIL_USER or ALERT_EMAIL_APP_PASSWORD for gmail-smtp');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass }
  });
  await transporter.sendMail({ from: from || user, to, subject, text: '' });
}

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]/g, ' ').trim();
}

function encodeSubject(value) {
  const clean = sanitizeHeader(value);
  if (/^[\x00-\x7F]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}
