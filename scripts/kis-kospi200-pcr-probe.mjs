import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requestKis } from '../src/providers/kis.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
await loadDotEnv(path.join(root, '.env'));

const MASTER_URL = 'https://new.real.download.dws.co.kr/common/master/fo_idx_code_mts.mst.zip';
const MASTER_DIR = path.join(root, 'data/kis-master');
const MASTER_ZIP = path.join(MASTER_DIR, 'fo_idx_code_mts.mst.zip');
const MASTER_FILE = path.join(MASTER_DIR, 'fo_idx_code_mts.mst');
const OUTPUT_FILE = path.join(root, 'data/kospi200-pcr-fullchain-probe.json');
const ERROR_FILE = path.join(root, 'data/kospi200-pcr-last-error.json');
const KST = 'Asia/Seoul';

const args = parseArgs(process.argv.slice(2));
const limitPerSide = Number(args['limit-per-side'] ?? 8);
const delayMs = Number(args['delay-ms'] ?? 1200);
const timeoutMs = Number(args['timeout-ms'] ?? 12000);
const full = Boolean(args.full);
const active = Boolean(args.active);
const expiryCount = Number(args['expiry-count'] ?? 1);
const strikesAround = Number(args['strikes-around'] ?? 10);
const sampleMode = args['sample-mode'] || 'atm';
const writeOutput = args.write !== false;

if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
  throw new Error('KIS_APP_KEY/KIS_APP_SECRET not configured');
}

const startedAt = new Date().toISOString();
await ensureIndexFutureOptionMaster();
const universe = await loadKospi200StandardOptionUniverse();
const selected = selectContracts(universe, { full, active, limitPerSide, sampleMode, expiryCount, strikesAround });
const sweepStarted = Date.now();
const callRows = await fetchContracts(selected.calls, { side: 'CALL', delayMs, timeoutMs });
if (selected.calls.length && selected.puts.length) await sleep(delayMs);
const putRows = await fetchContracts(selected.puts, { side: 'PUT', delayMs, timeoutMs });
const elapsedMs = Date.now() - sweepStarted;
const call = summarizeContracts(callRows);
const put = summarizeContracts(putRows);
const volumePcr = ratioOrNull(put.volume, call.volume);
const openInterestPcr = ratioOrNull(put.openInterest, call.openInterest);
const amountPcr = ratioOrNull(put.amount, call.amount);
const contractsRequested = selected.calls.length + selected.puts.length;
const contractsOk = call.ok + put.ok;
const payload = {
  id: 'kospi200_options_pcr_probe',
  generatedAt: new Date().toISOString(),
  startedAt,
  elapsedMs,
  elapsedSec: elapsedMs / 1000,
  mode: full ? 'full' : active ? 'active' : 'sample',
  sampleMode,
  selection: selected.meta,
  universe: {
    source: MASTER_URL,
    file: path.relative(root, MASTER_FILE),
    name: 'KOSPI200 standard monthly options only',
    include: { productKinds: { call: '5', put: '6' }, underlyingCode: '2001', underlyingName: 'KOSPI200' },
    exclude: ['mini KOSPI200 options', 'weekly KOSPI200 options', 'KOSDAQ150 options', 'single stock options'],
    total: universe.calls.length + universe.puts.length,
    calls: universe.calls.length,
    puts: universe.puts.length,
    atmCalls: universe.calls.filter(row => row.atmClass === '1').length,
    atmPuts: universe.puts.filter(row => row.atmClass === '1').length
  },
  requestPolicy: {
    source: 'KIS domestic futureoption inquire-price',
    sourcePath: '/uapi/domestic-futureoption/v1/quotations/inquire-price',
    trId: 'FHMIF10000000',
    delayMs,
    timeoutMs,
    fullSweepEstimatedSecAtThisDelay: ((universe.calls.length + universe.puts.length) * delayMs) / 1000,
    selectedSweepEstimatedSecAtThisDelay: ((selected.calls.length + selected.puts.length) * delayMs) / 1000
  },
  coverage: {
    contractsRequested,
    contractsOk,
    contractsError: contractsRequested - contractsOk,
    coveragePct: contractsRequested ? (contractsOk / contractsRequested) * 100 : null,
    universeCoveragePct: universe.calls.length + universe.puts.length ? (contractsOk / (universe.calls.length + universe.puts.length)) * 100 : null
  },
  call,
  put,
  volumePcr,
  volumePcrX100: volumePcr === null ? null : volumePcr * 100,
  amountPcr,
  openInterestPcr,
  status: full || active ? classifyProbeStatus({ contractsRequested, contractsOk, volumePcr, call, put }) : 'probe_sample',
  usableForSignal: Boolean((full || active) && contractsRequested > 0 && contractsOk / contractsRequested >= 0.98 && volumePcr !== null && call.volume > 0),
  warnings: [
    'This is a deterministic probe, not yet the production 1-minute dashboard path.',
    'KOSPI200 universe uses fo_idx_code_mts.mst, not fo_stk_code_mts.mst.',
    'Sample mode is for endpoint/field validation only; do not use sample PCR as a market signal.',
    'Active mode is a candidate universe only; reconcile against KRX EOD official totals before promoting to verified signal.',
    'Full-chain sweep can be slow because the current KOSPI200 standard option universe has thousands of contracts.'
  ],
  sample: {
    calls: callRows.slice(0, 10),
    puts: putRows.slice(0, 10)
  }
};

const shouldWriteOutput = writeOutput && (payload.usableForSignal || payload.mode === 'sample');
if (writeOutput) {
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  if (shouldWriteOutput) {
    await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  } else {
    await fs.writeFile(ERROR_FILE, `${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 2;
  }
}

console.log(JSON.stringify({
  status: payload.status,
  mode: payload.mode,
  selection: payload.selection,
  elapsedSec: payload.elapsedSec,
  universe: payload.universe,
  coverage: payload.coverage,
  volumePcr: payload.volumePcr,
  call: payload.call,
  put: payload.put,
  outputFile: shouldWriteOutput ? path.relative(root, OUTPUT_FILE) : null,
  errorFile: writeOutput && !shouldWriteOutput ? path.relative(root, ERROR_FILE) : null
}, null, 2));

async function ensureIndexFutureOptionMaster() {
  await fs.mkdir(MASTER_DIR, { recursive: true });
  const existing = await statOrNull(MASTER_FILE);
  const now = Date.now();
  if (existing && now - existing.mtimeMs < 12 * 60 * 60 * 1000) return;
  const res = await fetch(MASTER_URL, { headers: { 'user-agent': 'Mozilla/5.0 stock-dashboard-pcr-probe/0.1' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`KIS master download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(MASTER_ZIP, buf);
  await execFileAsync('unzip', ['-o', MASTER_ZIP, '-d', MASTER_DIR], { timeout: 20000 });
}

async function loadKospi200StandardOptionUniverse() {
  const text = await fs.readFile(MASTER_FILE, 'utf8').catch(async () => {
    const buf = await fs.readFile(MASTER_FILE);
    return new TextDecoder('euc-kr').decode(buf);
  });
  const rows = text.split(/\r?\n/).map(parseMasterRow).filter(Boolean)
    .filter(row => row.underlyingCode === '2001' && row.underlyingName === 'KOSPI200')
    .filter(row => row.productKind === '5' || row.productKind === '6')
    .sort((a, b) => contractSortKey(a).localeCompare(contractSortKey(b)));
  return {
    calls: rows.filter(row => row.productKind === '5'),
    puts: rows.filter(row => row.productKind === '6')
  };
}

function parseMasterRow(line) {
  if (!line.trim()) return null;
  const parts = line.split('|');
  if (parts.length < 9) return null;
  const [productKind, shortCode, standardCode, koreanName, atmClass, strike, expiryClass, underlyingCode, underlyingName] = parts.map(part => part.trim());
  const expiryMonth = parseExpiryMonth(koreanName);
  return { productKind, shortCode, standardCode, koreanName, atmClass, strike: numberOrNull(strike), expiryClass, underlyingCode, underlyingName, expiryMonth };
}

function selectContracts(universe, { full, active, limitPerSide, sampleMode, expiryCount, strikesAround }) {
  if (full) return { ...universe, meta: { mode: 'full', reason: 'all standard KOSPI200 option contracts' } };
  if (active) return selectActiveContracts(universe, { expiryCount, strikesAround });
  const pick = rows => {
    const candidates = sampleMode === 'atm' ? rows.filter(row => row.atmClass === '1') : rows;
    return (candidates.length ? candidates : rows).slice(0, limitPerSide);
  };
  return { calls: pick(universe.calls), puts: pick(universe.puts), meta: { mode: 'sample', sampleMode, limitPerSide } };
}

function selectActiveContracts(universe, { expiryCount, strikesAround }) {
  const expiries = Array.from(new Set([...universe.calls, ...universe.puts].map(row => row.expiryMonth).filter(Boolean))).sort().slice(0, expiryCount);
  const calls = [];
  const puts = [];
  const expiryDetails = [];
  for (const expiryMonth of expiries) {
    const expiryCalls = universe.calls.filter(row => row.expiryMonth === expiryMonth).sort(byStrikeThenCode);
    const expiryPuts = universe.puts.filter(row => row.expiryMonth === expiryMonth).sort(byStrikeThenCode);
    const atmStrike = findAtmStrike(expiryCalls, expiryPuts);
    calls.push(...selectAroundStrike(expiryCalls, atmStrike, strikesAround));
    puts.push(...selectAroundStrike(expiryPuts, atmStrike, strikesAround));
    expiryDetails.push({
      expiryMonth,
      atmStrike,
      availableCalls: expiryCalls.length,
      availablePuts: expiryPuts.length,
      selectedCalls: selectAroundStrike(expiryCalls, atmStrike, strikesAround).length,
      selectedPuts: selectAroundStrike(expiryPuts, atmStrike, strikesAround).length
    });
  }
  return {
    calls,
    puts,
    meta: {
      mode: 'active',
      policy: 'front expiry month(s), ATM-centered strike window',
      expiryCount,
      strikesAround,
      selectedExpiries: expiries,
      expiryDetails
    }
  };
}

function parseExpiryMonth(name) {
  const match = String(name || '').match(/(?:^|\s)(20\d{4})(?:\s|$)/);
  return match ? match[1] : null;
}

function findAtmStrike(calls, puts) {
  const atm = [...calls, ...puts].find(row => row.atmClass === '1' && row.strike !== null);
  if (atm) return atm.strike;
  const strikes = [...new Set([...calls, ...puts].map(row => row.strike).filter(v => v !== null))].sort((a, b) => a - b);
  return strikes.length ? strikes[Math.floor(strikes.length / 2)] : null;
}

function selectAroundStrike(rows, atmStrike, strikesAround) {
  if (!rows.length) return [];
  const sorted = rows.slice().sort(byStrikeThenCode);
  if (atmStrike === null || atmStrike === undefined) return sorted.slice(0, Math.min(sorted.length, (strikesAround * 2) + 1));
  let center = sorted.findIndex(row => row.strike === atmStrike);
  if (center === -1) {
    center = sorted.reduce((bestIndex, row, index) => {
      const best = sorted[bestIndex];
      return Math.abs(row.strike - atmStrike) < Math.abs(best.strike - atmStrike) ? index : bestIndex;
    }, 0);
  }
  return sorted.slice(Math.max(0, center - strikesAround), Math.min(sorted.length, center + strikesAround + 1));
}

function byStrikeThenCode(a, b) {
  return (a.strike ?? 0) - (b.strike ?? 0) || String(a.shortCode).localeCompare(String(b.shortCode));
}

async function fetchContracts(contracts, { side, delayMs, timeoutMs }) {
  const out = [];
  for (let index = 0; index < contracts.length; index += 1) {
    const contract = contracts[index];
    const started = Date.now();
    try {
      const query = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'O',
        FID_INPUT_ISCD: contract.shortCode
      }).toString();
      const { json, url } = await requestKis({
        path: '/uapi/domestic-futureoption/v1/quotations/inquire-price',
        trId: 'FHMIF10000000',
        query
      }, process.env, { timeoutMs });
      const row = json.output1 || json.output || {};
      const rtOk = json.rt_cd === '0' && Object.keys(row).length > 0;
      out.push({
        ...contract,
        side,
        ok: rtOk,
        message: rtOk ? null : (json.msg1 || 'KIS empty/non-zero response'),
        volume: numberOrNull(row.acml_vol),
        amount: numberOrNull(row.acml_tr_pbmn),
        openInterest: numberOrNull(row.hts_otst_stpl_qty),
        openInterestChange: numberOrNull(row.otst_stpl_qty_icdc),
        price: numberOrNull(row.futs_prpr ?? row.optn_prpr),
        rawName: row.hts_kor_isnm || null,
        underlyingIndex: numberOrNull(json.output3?.bstp_nmix_prpr),
        sourceUrl: url,
        elapsedMs: Date.now() - started
      });
    } catch (err) {
      out.push({ ...contract, side, ok: false, message: err.name === 'AbortError' ? 'KIS inquire-price timeout' : err.message, elapsedMs: Date.now() - started });
    }
    if (index < contracts.length - 1) await sleep(delayMs);
  }
  return out;
}

function summarizeContracts(rows) {
  const okRows = rows.filter(row => row.ok);
  return {
    requested: rows.length,
    ok: okRows.length,
    error: rows.length - okRows.length,
    volume: sum(okRows, 'volume'),
    amount: sum(okRows, 'amount'),
    openInterest: sum(okRows, 'openInterest'),
    openInterestChange: sum(okRows, 'openInterestChange'),
    nonZeroVolumeContracts: okRows.filter(row => Number(row.volume || 0) > 0).length,
    errors: rows.filter(row => !row.ok).slice(0, 5).map(row => ({ shortCode: row.shortCode, name: row.koreanName, message: row.message }))
  };
}

function classifyProbeStatus({ contractsRequested, contractsOk, volumePcr, call }) {
  if (!contractsRequested) return 'no_contracts';
  if (contractsOk / contractsRequested < 0.98) return 'partial';
  if (call.volume <= 0 || volumePcr === null) return 'no_signal_volume';
  return 'full_chain_probe_ok';
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

function contractSortKey(row) {
  return `${String(row.koreanName).replace(/\s+/g, ' ')}|${String(row.strike).padStart(10, '0')}|${row.shortCode}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') out.full = true;
    else if (arg === '--no-write') out.write = false;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    }
  }
  return out;
}

async function statOrNull(file) {
  try { return await fs.stat(file); } catch { return null; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
