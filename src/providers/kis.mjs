import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failedStatus, okStatus, delayedStatus } from '../status.mjs';
import { kisCredentialLifecycle, classifyKisAuthError } from '../kis-credential-status.mjs';

const PROD_BASE = 'https://openapi.koreainvestment.com:9443';
const PAPER_BASE = 'https://openapivts.koreainvestment.com:29443';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TOKEN_CACHE_FILE = path.join(ROOT, 'data/kis-token-cache.json');
const FUTURES_BOARD_CACHE_FILE = path.join(ROOT, 'data/kis-futures-board-cache.json');
const TOKEN_REFRESH_SAFETY_MS = 10 * 60 * 1000;

export function kisConfigured(env = process.env) {
  return Boolean(env.KIS_APP_KEY && env.KIS_APP_SECRET);
}

export function kisBaseUrl(env = process.env) {
  return env.KIS_MODE === 'paper' ? PAPER_BASE : PROD_BASE;
}

export async function getKisAccessToken(env = process.env, { timeoutMs = 8000, forceRefresh = false } = {}) {
  if (!kisConfigured(env)) throw new Error('KIS_APP_KEY/KIS_APP_SECRET not configured');

  if (!forceRefresh) {
    const cached = await readTokenCache(env);
    if (cached?.access_token && cached.expiresAt && Date.now() < new Date(cached.expiresAt).getTime() - TOKEN_REFRESH_SAFETY_MS) {
      return { access_token: cached.access_token, token_type: cached.token_type || 'Bearer', expiresAt: cached.expiresAt, fromCache: true };
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${kisBaseUrl(env)}/oauth2/tokenP`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`KIS token HTTP ${res.status}: ${json.msg1 || json.error_description || json.message || 'token failed'}`);
    if (!json.access_token) throw new Error('KIS token response missing access_token');

    const expiresAt = inferExpiresAt(json);
    const token = {
      mode: env.KIS_MODE || 'prod',
      baseUrl: kisBaseUrl(env),
      access_token: json.access_token,
      token_type: json.token_type || 'Bearer',
      expiresAt,
      issuedAt: new Date().toISOString(),
      fromCache: false
    };
    await writeTokenCache(token);
    return token;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestKis({ path, trId, query = '', method = 'GET', body = null }, env = process.env, { timeoutMs = 8000 } = {}) {
  if (!path || !trId) throw new Error('KIS path/trId required');
  const token = await getKisAccessToken(env, { timeoutMs });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${kisBaseUrl(env)}${path}${query ? `?${query}` : ''}`;
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token.access_token}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: trId,
        custtype: 'P'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`KIS HTTP ${res.status}: ${json.msg1 || json.error_description || json.message || 'request failed'}`);
    return { json, url, trId, tokenFromCache: token.fromCache };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchKisMetric(metric, { timeoutMs = 8000 } = {}) {
  if (!kisConfigured()) {
    return skeletonMetric(metric, failedStatus('KIS credentials not configured. Copy .env.example to .env and fill keys.', { errorKind: 'KIS_KEY_MISSING' }));
  }

  if (!process.env.KIS_TEST_PATH || !process.env.KIS_TEST_TR_ID) {
    try {
      const token = await getKisAccessToken(process.env, { timeoutMs });
      const lifecycle = kisCredentialLifecycle(process.env);
      const baseStatus = lifecycle.level === 'warn'
        ? delayedStatus({ marketState: 'KIS_CREDENTIAL_RENEWAL_SOON', message: lifecycle.message })
        : lifecycle.level === 'error'
          ? failedStatus(lifecycle.message, { errorKind: 'KIS_KEY_EXPIRED' })
          : okStatus({ marketState: 'KIS_TOKEN_OK', message: `token OK (${token.fromCache ? 'cache' : 'fresh'}), ${lifecycle.message}` });
      return skeletonMetric(metric, baseStatus, { kisTokenExpiresAt: token.expiresAt, kisCredential: lifecycle });
    } catch (err) {
      const message = err.name === 'AbortError' ? 'KIS token timeout' : err.message;
      return skeletonMetric(metric, failedStatus(message, { errorKind: classifyKisAuthError(message) }));
    }
  }

  try {
    const { json, url, trId, tokenFromCache } = await requestKis({
      path: process.env.KIS_TEST_PATH,
      trId: process.env.KIS_TEST_TR_ID,
      query: process.env.KIS_TEST_QUERY || ''
    }, process.env, { timeoutMs });

    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'kis',
      symbol: metric.symbol,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value: null,
      change: null,
      changePct: null,
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      status: okStatus({ marketState: 'KIS_CONNECTED', message: `TR ${trId} connected; token ${tokenFromCache ? 'cache' : 'fresh'}` }),
      sourceUrl: url,
      rawPreview: JSON.stringify(json).slice(0, 800)
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'KIS timeout' : err.message;
    return skeletonMetric(metric, failedStatus(message, { errorKind: classifyKisAuthError(message) }));
  }
}

export async function fetchKisFuturesBoardMetric(metric, { timeoutMs = 8000 } = {}) {
  if (!kisConfigured()) return skeletonMetric(metric, failedStatus('KIS credentials not configured.'));
  try {
    const query = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: metric.kisMarketDiv || 'F',
      FID_COND_SCR_DIV_CODE: metric.kisScreenCode || '20503',
      FID_COND_MRKT_CLS_CODE: metric.kisMarketClass || ''
    }).toString();
    const { json, url, tokenFromCache, retryCount } = await requestKisWithRetry({
      path: '/uapi/domestic-futureoption/v1/quotations/display-board-futures',
      trId: 'FHPIF05030200',
      query
    }, process.env, { timeoutMs, attempts: 3, baseDelayMs: 700 });
    const rows = Array.isArray(json.output) ? json.output : [];
    const row = rows.find(r => !metric.kisNameIncludes || String(r.hts_kor_isnm || '').includes(metric.kisNameIncludes)) || rows[0];
    if (!row) throw new Error(`KIS futures board empty: ${json.msg1 || 'no output'}`);
    const value = numberOrNull(row.futs_prpr);
    if (value === null) throw new Error('KIS futures board missing futs_prpr');
    const output = {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'kis',
      symbol: row.futs_shrn_iscd || metric.symbol,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value,
      change: numberOrNull(row.futs_prdy_vrss),
      changePct: numberOrNull(row.futs_prdy_ctrt),
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      status: okStatus({ marketState: metric.activeMarket || 'KIS_FUTURES', message: `${row.hts_kor_isnm || 'futures'}; token ${tokenFromCache ? 'cache' : 'fresh'}${retryCount ? `; retry ${retryCount}` : ''}` }),
      sourceUrl: url,
      rawName: row.hts_kor_isnm || null
    };
    await writeKisFuturesBoardCache(metric.id, output);
    return output;
  } catch (err) {
    const message = err.name === 'AbortError' ? 'KIS futures timeout' : err.message;
    const cached = await readKisFuturesBoardCache(metric.id);
    if (cached && isRetryableKisQuoteError(message)) {
      return {
        ...cached,
        fetchedAt: new Date().toISOString(),
        status: delayedStatus({
          marketState: 'KIS_FUTURES_RECENT_CACHE',
          label: 'KIS 일시불안/최근값',
          message: `KIS 전광판 일시 실패 (${message}); 최근 정상 수집값 ${cached.fetchedAt ? new Date(cached.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : ''} 기준 표시`
        }),
        cacheFallbackFrom: cached.fetchedAt || null,
        primaryError: message
      };
    }
    return skeletonMetric(metric, failedStatus(message, { errorKind: classifyKisAuthError(message) }));
  }
}

async function requestKisWithRetry(request, env = process.env, { timeoutMs = 8000, attempts = 3, baseDelayMs = 700 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await requestKis(request, env, { timeoutMs });
      return { ...result, retryCount: attempt - 1 };
    } catch (err) {
      lastErr = err;
      const message = err.name === 'AbortError' ? 'KIS futures timeout' : err.message || '';
      if (attempt >= attempts || !isRetryableKisQuoteError(message)) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}

function isRetryableKisQuoteError(message = '') {
  return /KIS HTTP 500|재 조회|초당 거래건수|timeout|aborted/i.test(String(message));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readKisFuturesBoardCache(id) {
  try {
    const cache = JSON.parse(await fs.readFile(FUTURES_BOARD_CACHE_FILE, 'utf8'));
    return cache?.[id] || null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeKisFuturesBoardCache(id, metric) {
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(FUTURES_BOARD_CACHE_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  cache[id] = {
    ...metric,
    cachedAt: new Date().toISOString()
  };
  await fs.mkdir(path.dirname(FUTURES_BOARD_CACHE_FILE), { recursive: true });
  await fs.writeFile(FUTURES_BOARD_CACHE_FILE, JSON.stringify(cache, null, 2));
}

export async function fetchKisBondYieldMetric(metric, { timeoutMs = 8000 } = {}) {
  if (!kisConfigured()) return skeletonMetric(metric, failedStatus('KIS credentials not configured.'));
  try {
    const query = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: metric.kisMarketDiv || 'B',
      FID_INPUT_ISCD: metric.kisIsin || metric.symbol
    }).toString();
    const { json, url, tokenFromCache } = await requestKis({
      path: '/uapi/domestic-bond/v1/quotations/inquire-price',
      trId: 'FHKBJ773400C0',
      query
    }, process.env, { timeoutMs });
    const row = json.output || {};
    const rawYield = numberOrNull(row.ernn_rate);
    const volume = numberOrNull(row.acml_vol);
    const value = rawYield === 0 && volume === 0 ? null : rawYield;
    if (rawYield === null) throw new Error(`KIS bond missing ernn_rate: ${json.msg1 || 'no yield field'}`);
    const status = value === null
      ? delayedStatus({ marketState: 'KIS_BOND', label: '소스검증필요', message: `${row.hts_kor_isnm || metric.name}; KIS returned 0.000 yield with 0 volume, not displaying as real yield` })
      : okStatus({ marketState: 'KIS_BOND', message: `${row.hts_kor_isnm || metric.name}; token ${tokenFromCache ? 'cache' : 'fresh'}` });
    return {
      id: metric.id,
      name: metric.name,
      group: metric.group,
      groupOrder: metric.groupOrder,
      groupLabel: metric.groupLabel,
      groupDescription: metric.groupDescription,
      provider: 'kisBond',
      symbol: row.stnd_iscd || metric.symbol,
      unit: metric.unit || '',
      decimals: metric.decimals,
      displayNote: metric.displayNote || null,
      value,
      change: null,
      changePct: numberOrNull(row.prdy_ctrt),
      timestamp: null,
      fetchedAt: new Date().toISOString(),
      status,
      sourceUrl: url,
      rawName: row.hts_kor_isnm || null
    };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'KIS bond timeout' : err.message;
    return skeletonMetric(metric, failedStatus(message, { errorKind: classifyKisAuthError(message) }));
  }
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function skeletonMetric(metric, status, extra = {}) {
  return {
    id: metric.id,
    name: metric.name,
    group: metric.group,
    groupOrder: metric.groupOrder,
    groupLabel: metric.groupLabel,
    groupDescription: metric.groupDescription,
    provider: 'kis',
    symbol: metric.symbol,
    unit: metric.unit || '',
    decimals: metric.decimals,
    displayNote: metric.displayNote || null,
    value: null,
    change: null,
    changePct: null,
    timestamp: null,
    fetchedAt: new Date().toISOString(),
    status,
    ...extra,
    sourceUrl: kisBaseUrl()
  };
}

async function readTokenCache(env) {
  try {
    const cached = JSON.parse(await fs.readFile(TOKEN_CACHE_FILE, 'utf8'));
    if (cached.mode !== (env.KIS_MODE || 'prod')) return null;
    if (cached.baseUrl !== kisBaseUrl(env)) return null;
    return cached;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
}

async function writeTokenCache(token) {
  await fs.mkdir(path.dirname(TOKEN_CACHE_FILE), { recursive: true });
  await fs.writeFile(TOKEN_CACHE_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

function inferExpiresAt(json) {
  if (json.access_token_token_expired) {
    const raw = String(json.access_token_token_expired).trim();
    const compact = raw.match(/^(\d{8})(\d{6})$/);
    if (compact) {
      const [, ymd, hms] = compact;
      const iso = `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}T${hms.slice(0,2)}:${hms.slice(2,4)}:${hms.slice(4,6)}+09:00`;
      const t = new Date(iso);
      if (!Number.isNaN(t.getTime())) return t.toISOString();
    }
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const seconds = Number(json.expires_in || json.expiresIn || 24 * 60 * 60);
  return new Date(Date.now() + seconds * 1000).toISOString();
}
