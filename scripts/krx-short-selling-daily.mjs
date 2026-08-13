import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
await loadDotEnv(path.join(root, '.env'));

const OUTPUT_FILE = path.join(root, 'data/krx-short-selling-daily.json');
const DATA_URL = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
const LOGIN_PAGE = 'https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001.cmd';
const LOGIN_JSP = 'https://data.krx.co.kr/contents/MDC/COMS/client/view/login.jsp?site=mdc';
const LOGIN_URL = 'https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001D1.cmd';
const REFERER = 'https://data.krx.co.kr/contents/MDC/MDI/outerLoader/index.cmd';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 stock-dashboard-krx-short/0.1';

const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number(args['timeout-ms'] || 15000);
const writeOutput = args.write !== false;
const endDd = String(args.endDd || args.date || formatKstDateCompact(new Date()));
const days = Number(args.days || 12);
const strtDd = String(args.strtDd || compactDateOffset(endDd, -(days - 1)));

const WATCHLIST = [
  { id: 'samsung_electronics', name: '삼성전자', ticker: '005930', isin: 'KR7005930003', market: 'KOSPI' },
  { id: 'sk_hynix', name: 'SK하이닉스', ticker: '000660', isin: 'KR7000660001', market: 'KOSPI' }
];

const startedAt = new Date().toISOString();
const krxId = process.env.KRX_ID || '';
const krxPw = process.env.KRX_PW || '';

if (!krxId || !krxPw) {
  const payload = {
    id: 'krx_short_selling_daily',
    status: 'blocked_missing_krx_login',
    message: 'KRX data.krx.co.kr short-selling screens currently require a logged-in KRX Data session. Set KRX_ID and KRX_PW in .env to enable official daily short-selling refresh.',
    startedAt,
    generatedAt: new Date().toISOString(),
    requestedRange: { strtDd, endDd },
    expectedLag: 'KRX short-selling balance data is commonly available with about T+2 disclosure lag; trading data can also lag around non-business days.',
    source: 'KRX Data Marketplace short-selling statistics',
    sourcePaths: {
      tradingByIssueTrend: 'dbms/MDC/STAT/srt/MDCSTAT30102',
      balanceByIssueTrend: 'dbms/MDC/STAT/srt/MDCSTAT30502'
    },
    items: WATCHLIST.map(stock => ({ ...stock, status: 'blocked_missing_krx_login' }))
  };
  if (writeOutput) await writeJson(OUTPUT_FILE, payload);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

try {
  const session = await createKrxSession({ krxId, krxPw, timeoutMs });
  const items = [];
  for (const stock of WATCHLIST) {
    const tradingRows = await fetchKrxJson(session, {
      bld: 'dbms/MDC/STAT/srt/MDCSTAT30102',
      strtDd,
      endDd,
      isuCd: stock.isin
    }, { timeoutMs });
    const balanceRows = await fetchKrxJson(session, {
      bld: 'dbms/MDC/STAT/srt/MDCSTAT30502',
      strtDd,
      endDd,
      isuCd: stock.isin
    }, { timeoutMs });
    items.push(buildStockPayload(stock, tradingRows, balanceRows));
    await sleep(350);
  }
  const usable = items.some(item => item.latestTrading || item.latestBalance);
  const payload = {
    id: 'krx_short_selling_daily',
    status: usable ? 'ok' : 'no_data',
    startedAt,
    generatedAt: new Date().toISOString(),
    requestedRange: { strtDd, endDd },
    expectedLag: '잔고는 통상 T+2 안팎 지연 공시. 아침 갱신은 최근 12일을 뒤로 훑어 최신 유효 거래일을 잡음.',
    source: 'KRX Data Marketplace short-selling statistics',
    sourcePaths: {
      tradingByIssueTrend: 'dbms/MDC/STAT/srt/MDCSTAT30102',
      balanceByIssueTrend: 'dbms/MDC/STAT/srt/MDCSTAT30502'
    },
    items
  };
  if (writeOutput) await writeJson(OUTPUT_FILE, payload);
  console.log(JSON.stringify({ status: payload.status, requestedRange: payload.requestedRange, items: items.map(summarizeConsoleItem), outputFile: writeOutput ? path.relative(root, OUTPUT_FILE) : null }, null, 2));
} catch (err) {
  const payload = {
    id: 'krx_short_selling_daily',
    status: 'error',
    startedAt,
    generatedAt: new Date().toISOString(),
    requestedRange: { strtDd, endDd },
    message: err.name === 'AbortError' ? 'KRX short-selling fetch timeout' : err.message,
    source: 'KRX Data Marketplace short-selling statistics',
    items: WATCHLIST.map(stock => ({ ...stock, status: 'error', message: err.message }))
  };
  if (writeOutput) await writeJson(OUTPUT_FILE, payload);
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
}

function buildStockPayload(stock, tradingRowsRaw, balanceRowsRaw) {
  const tradingRows = normalizeTradingRows(tradingRowsRaw).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const balanceRows = normalizeBalanceRows(balanceRowsRaw).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const latestTrading = latestFinalTradingRow(tradingRows);
  const previousTrading = previousBefore(tradingRows, latestTrading?.tradeDate);
  const latestBalance = lastWithDate(balanceRows);
  const previousBalance = previousBefore(balanceRows, latestBalance?.tradeDate);
  const shortVolumeDelta = latestTrading && previousTrading ? latestTrading.shortSellVolume - previousTrading.shortSellVolume : null;
  const totalVolumeDelta = latestTrading && previousTrading ? latestTrading.totalVolume - previousTrading.totalVolume : null;
  const shortRatioDeltaPctp = latestTrading && previousTrading && latestTrading.shortSellVolumeRatioPct !== null && previousTrading.shortSellVolumeRatioPct !== null
    ? latestTrading.shortSellVolumeRatioPct - previousTrading.shortSellVolumeRatioPct
    : null;
  const balanceDelta = latestBalance && previousBalance ? latestBalance.shortSellBalance - previousBalance.shortSellBalance : null;
  return {
    ...stock,
    status: latestTrading || latestBalance ? 'ok' : 'no_data',
    latestTrading,
    previousTrading,
    latestBalance,
    previousBalance,
    deltas: {
      shortSellVolume: shortVolumeDelta,
      totalVolume: totalVolumeDelta,
      shortSellVolumeRatioPctp: shortRatioDeltaPctp,
      shortSellBalance: balanceDelta
    },
    displayNote: latestTrading && latestTrading.tradeDate !== lastWithDate(tradingRows)?.tradeDate ? '당일 공매도 0 표시는 장중/확정 전 예비값으로 판단해 최신 확정 거래일을 표시' : null,
    history: tradingRows.slice(-8).map(row => ({ 
      tradeDate: row.tradeDate,
      shortSellVolume: row.shortSellVolume,
      totalVolume: row.totalVolume,
      shortSellVolumeRatioPct: row.shortSellVolumeRatioPct
    })),
    balanceHistory: balanceRows.slice(-8).map(row => ({
      tradeDate: row.tradeDate,
      shortSellBalance: row.shortSellBalance,
      listedShares: row.listedShares,
      balanceRatioPct: row.balanceRatioPct
    }))
  };
}

function normalizeTradingRows(rows) {
  return rows.map(row => {
    const shortSellVolume = num(row.CVSRTSELL_TRDVOL ?? row.SRTSELL_TRDVOL ?? row.공매도 ?? row.공매도거래량);
    const totalVolume = num(row.ACC_TRDVOL ?? row.TDD_TRDVOL ?? row.거래량);
    const shortSellValue = num(row.CVSRTSELL_TRDVAL ?? row.SRTSELL_TRDVAL ?? row.공매도거래대금);
    const totalValue = num(row.ACC_TRDVAL ?? row.TDD_TRDVAL ?? row.거래대금);
    return {
      tradeDate: normalizeDate(row.TRD_DD ?? row.BAS_DD ?? row.날짜),
      shortSellVolume,
      totalVolume,
      shortSellVolumeRatioPct: num(row.TRDVOL_WT ?? row.TDD_SRTSELL_WT ?? row.비중) ?? pct(shortSellVolume, totalVolume),
      shortSellValue,
      totalValue,
      shortSellValueRatioPct: num(row.TRDVAL_WT) ?? pct(shortSellValue, totalValue)
    };
  }).filter(row => row.tradeDate);
}

function normalizeBalanceRows(rows) {
  return rows.map(row => {
    const shortSellBalance = num(row.BAL_QTY ?? row.SRTSELL_BAL_QTY ?? row.CVSRTSELL_BAL_QTY ?? row.공매도잔고 ?? row.STR_CONST_VAL1);
    const listedShares = num(row.LIST_SHRS ?? row.LIST_SHRS_QTY ?? row.상장주식수 ?? row.STR_CONST_VAL2);
    const shortSellBalanceValue = num(row.BAL_AMT ?? row.SRTSELL_BAL_AMT ?? row.CVSRTSELL_BAL_AMT ?? row.공매도금액 ?? row.STR_CONST_VAL3);
    const marketCap = num(row.MKTCAP ?? row.시가총액 ?? row.STR_CONST_VAL4);
    return {
      tradeDate: normalizeDate(row.RPT_DUTY_OCCR_DD ?? row.TRD_DD ?? row.BAS_DD ?? row.날짜),
      shortSellBalance,
      listedShares,
      shortSellBalanceValue,
      marketCap,
      balanceRatioPct: num(row.BAL_RTO ?? row.WT ?? row.RTO ?? row.비중) ?? pct(shortSellBalance, listedShares)
    };
  }).filter(row => row.tradeDate);
}

async function createKrxSession({ krxId, krxPw, timeoutMs }) {
  const jar = new Map();
  await krxFetch(LOGIN_PAGE, { method: 'GET', jar, timeoutMs });
  await krxFetch(LOGIN_JSP, { method: 'GET', jar, timeoutMs, headers: { referer: LOGIN_PAGE } });
  let login = await krxFetch(LOGIN_URL, {
    method: 'POST',
    jar,
    timeoutMs,
    headers: { referer: LOGIN_PAGE, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ mbrNm: '', telNo: '', di: '', certType: '', mbrId: krxId, pw: krxPw })
  });
  let json = await login.json();
  if (json?._error_code === 'CD011') {
    login = await krxFetch(LOGIN_URL, {
      method: 'POST',
      jar,
      timeoutMs,
      headers: { referer: LOGIN_PAGE, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ mbrNm: '', telNo: '', di: '', certType: '', mbrId: krxId, pw: krxPw, skipDup: 'Y' })
    });
    json = await login.json();
  }
  if (json?._error_code !== 'CD001') throw new Error(`KRX login failed: ${json?._error_code || 'unknown'} ${json?._error_message || ''}`.trim());
  return { jar };
}

async function fetchKrxJson(session, params, { timeoutMs }) {
  const res = await krxFetch(DATA_URL, {
    method: 'POST',
    jar: session.jar,
    timeoutMs,
    headers: {
      referer: REFERER,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest'
    },
    body: new URLSearchParams(params)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`KRX HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (!json) throw new Error(`KRX non-JSON response: ${text.slice(0, 200)}`);
  if (json._error_code && json._error_code !== '0') throw new Error(`KRX error ${json._error_code}: ${json._error_message || ''}`);
  const rows = json.OutBlock_1 || json.output || json.block1 || [];
  return Array.isArray(rows) ? rows : [];
}

async function krxFetch(url, { method = 'GET', jar, timeoutMs, headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json, text/javascript, */*; q=0.01',
      cookie: cookieHeader(jar),
      ...headers
    },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  updateCookies(jar, res.headers);
  return res;
}

function updateCookies(jar, headers) {
  if (!jar) return;
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const header of setCookies) {
    const [pair] = String(header).split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
}

function cookieHeader(jar) {
  if (!jar || !jar.size) return '';
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function latestFinalTradingRow(rows) {
  const dated = rows.filter(row => row.tradeDate);
  const today = formatKstDateIso(new Date());
  const nowKstMinutes = currentKstMinutes(new Date());
  // KRX can expose today's total volume before the short-selling fields are finalized.
  // Before 18:30 KST, treat today's zero short-selling row as preliminary and keep
  // showing the latest previous finalized row instead of a misleading 0.
  const finalized = dated.filter(row => !(row.tradeDate === today && nowKstMinutes < 18 * 60 + 30 && Number(row.shortSellVolume || 0) === 0));
  return finalized.at(-1) || dated.at(-1) || null;
}
function lastWithDate(rows) { return rows.filter(row => row.tradeDate).at(-1) || null; }
function previousBefore(rows, tradeDate) { return rows.filter(row => row.tradeDate && row.tradeDate < tradeDate).at(-1) || null; }
function pct(a, b) { return a !== null && b ? (a / b) * 100 : null; }
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').replace(/%/g, '').trim());
  return Number.isFinite(n) ? n : null;
}
function normalizeDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return s.replaceAll('/', '-');
}
function summarizeConsoleItem(item) {
  return { name: item.name, status: item.status, latestTrading: item.latestTrading?.tradeDate || null, shortSellVolume: item.latestTrading?.shortSellVolume ?? null, totalVolume: item.latestTrading?.totalVolume ?? null, shortSellBalanceDate: item.latestBalance?.tradeDate || null, shortSellBalance: item.latestBalance?.shortSellBalance ?? null, displayNote: item.displayNote || null };
}
async function writeJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
}
function formatKstDateCompact(date) {
  return formatKstDateIso(date).replace(/-/g, '');
}
function formatKstDateIso(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function currentKstMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}
function compactDateOffset(yyyymmdd, offsetDays) {
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return formatKstDateCompact(d);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-write') out.write = false;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    }
  }
  return out;
}
async function loadDotEnv(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}
