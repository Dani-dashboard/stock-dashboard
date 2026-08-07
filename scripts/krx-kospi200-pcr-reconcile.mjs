import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
await loadDotEnv(path.join(root, '.env'));

const API_URL = 'https://data-dbg.krx.co.kr/svc/apis/drv/opt_bydd_trd';
const OUTPUT_FILE = path.join(root, 'data/kospi200-pcr-krx-eod.json');
const args = parseArgs(process.argv.slice(2));
const basDd = String(args.basDd || args.date || formatKstDateCompact(new Date()));
const authKey = process.env.KRX_OPENAPI_AUTH_KEY || process.env.KRX_AUTH_KEY || process.env.KRX_DATA_AUTH_KEY || '';
const timeoutMs = Number(args['timeout-ms'] || 15000);
const writeOutput = args.write !== false;

if (!authKey) {
  const payload = {
    id: 'kospi200_options_pcr_krx_eod',
    status: 'blocked_missing_auth_key',
    message: 'KRX OpenAPI auth key is not configured. Set KRX_OPENAPI_AUTH_KEY in .env to enable official EOD PCR reconciliation.',
    basDd,
    source: 'KRX OpenAPI options daily trading information',
    sourcePath: '/svc/apis/drv/opt_bydd_trd',
    generatedAt: new Date().toISOString(),
    usableForVerification: false
  };
  if (writeOutput) await writeJson(OUTPUT_FILE, payload);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const startedAt = new Date().toISOString();
try {
  const url = `${API_URL}?${new URLSearchParams({ basDd })}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 stock-dashboard-krx-pcr/0.1', AUTH_KEY: authKey, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`KRX OpenAPI HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!json) throw new Error(`KRX OpenAPI non-JSON response: ${text.slice(0, 300)}`);

  const rows = extractRows(json);
  const classified = rows.map(normalizeKrxOptionRow).filter(row => row.productMatch && (row.side === 'CALL' || row.side === 'PUT'));
  const callRows = classified.filter(row => row.side === 'CALL');
  const putRows = classified.filter(row => row.side === 'PUT');
  const call = summarize(callRows);
  const put = summarize(putRows);
  const volumePcr = ratioOrNull(put.volume, call.volume);
  const amountPcr = ratioOrNull(put.amount, call.amount);
  const openInterestPcr = ratioOrNull(put.openInterest, call.openInterest);
  const payload = {
    id: 'kospi200_options_pcr_krx_eod',
    status: volumePcr === null ? 'no_signal_volume' : 'ok',
    basDd,
    startedAt,
    generatedAt: new Date().toISOString(),
    source: 'KRX OpenAPI options daily trading information',
    sourcePath: '/svc/apis/drv/opt_bydd_trd',
    sourceUrl: url.replace(/([?&]AUTH_KEY=)[^&]+/i, '$1***'),
    universe: {
      name: 'KOSPI200 standard options official EOD rows inferred from KRX OpenAPI',
      matchingRule: 'rows whose product/issue fields indicate KOSPI200 options; side inferred from right/type/name fields',
      rowsTotal: rows.length,
      rowsMatched: classified.length,
      callRows: callRows.length,
      putRows: putRows.length
    },
    call,
    put,
    volumePcr,
    volumePcrX100: volumePcr === null ? null : volumePcr * 100,
    amountPcr,
    openInterestPcr,
    usableForVerification: volumePcr !== null,
    rawKeysSample: rows[0] ? Object.keys(rows[0]).slice(0, 80) : [],
    sampleRows: classified.slice(0, 10)
  };
  if (writeOutput) await writeJson(OUTPUT_FILE, payload);
  console.log(JSON.stringify({
    status: payload.status,
    basDd,
    universe: payload.universe,
    volumePcr: payload.volumePcr,
    call: payload.call,
    put: payload.put,
    outputFile: writeOutput ? path.relative(root, OUTPUT_FILE) : null
  }, null, 2));
} catch (err) {
  const payload = {
    id: 'kospi200_options_pcr_krx_eod',
    status: 'error',
    basDd,
    startedAt,
    generatedAt: new Date().toISOString(),
    source: 'KRX OpenAPI options daily trading information',
    sourcePath: '/svc/apis/drv/opt_bydd_trd',
    message: err.name === 'AbortError' ? 'KRX OpenAPI timeout' : err.message,
    usableForVerification: false
  };
  if (writeOutput) await writeJson(OUTPUT_FILE, payload);
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
}

function extractRows(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['OutBlock_1', 'output', 'data', 'result', 'items']) {
    const value = json?.[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      for (const sub of ['OutBlock_1', 'output', 'data', 'items']) {
        if (Array.isArray(value[sub])) return value[sub];
      }
    }
  }
  return [];
}

function normalizeKrxOptionRow(raw) {
  const get = (...keys) => keys.map(key => raw[key]).find(value => value !== undefined && value !== null && value !== '');
  const nameText = [
    get('PROD_NM', 'prodNm', 'prod_nm', '상품명'),
    get('ISU_NM', 'isuNm', 'isu_nm', '종목명'),
    get('ISU_ABBRV', 'isuAbrv', 'isu_abbrv', '종목약명'),
    get('RGHT_TP_NM', 'rghtTpNm', 'rght_tp_nm', '권리유형'),
    get('OPT_TP_NM', 'optTpNm', 'opt_tp_nm', '옵션유형')
  ].filter(Boolean).join(' ');
  const compact = nameText.replace(/\s+/g, '').toUpperCase();
  const productMatch = /KOSPI200|코스피200|K200/.test(compact) && !/미니|MINI|위클리|WEEKLY|코스닥|KOSDAQ|KSQ/.test(compact);
  const side = inferSide(raw, compact);
  return {
    raw,
    productMatch,
    side,
    tradeDate: get('BAS_DD', 'basDd', 'TRD_DD', 'trdDd', '기준일자') || null,
    issueCode: get('ISU_CD', 'isuCd', 'ISU_SRT_CD', 'isuSrtCd', '종목코드') || null,
    issueName: get('ISU_NM', 'isuNm', 'ISU_ABBRV', 'isuAbrv', '종목명') || null,
    volume: numberOrNull(get('ACC_TRDVOL', 'accTrdvol', 'ACC_TRD_VOL', 'acc_trdvol', '거래량')),
    amount: numberOrNull(get('ACC_TRDVAL', 'accTrdval', 'ACC_TRD_VAL', 'acc_trdval', '거래대금')),
    openInterest: numberOrNull(get('ACC_OPNINT_QTY', 'accOpnintQty', 'OPNINT_QTY', 'opnintQty', '미결제약정')),
    rightType: get('RGHT_TP_NM', 'rghtTpNm', 'RGHT_TP_CD', 'rghtTpCd') || null
  };
}

function inferSide(raw, compactText) {
  const values = Object.values(raw).map(v => String(v ?? '').trim().toUpperCase());
  const joined = `${compactText} ${values.join(' ')}`;
  if (/(^|\s)(CALL|콜|C)(\s|$)|지수콜|콜옵션|\bC\d/.test(joined)) return 'CALL';
  if (/(^|\s)(PUT|풋|P)(\s|$)|지수풋|풋옵션|\bP\d/.test(joined)) return 'PUT';
  return null;
}

function summarize(rows) {
  return {
    rows: rows.length,
    volume: sum(rows, 'volume'),
    amount: sum(rows, 'amount'),
    openInterest: sum(rows, 'openInterest'),
    nonZeroVolumeRows: rows.filter(row => Number(row.volume || 0) > 0).length
  };
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (numberOrNull(row[key]) ?? 0), 0);
}

function ratioOrNull(numerator, denominator) {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined || Number(denominator) === 0) return null;
  const ratio = Number(numerator) / Number(denominator);
  return Number.isFinite(ratio) ? ratio : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

async function writeJson(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function formatKstDateCompact(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replace(/-/g, '');
}

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
