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
const FREESIS_LOAN_URL = 'http://freesis.kofia.or.kr/meta/getMetaDataList.do';
const FREESIS_REFERER = 'http://freesis.kofia.or.kr/stat/FreeSIS.do?parentDivId=MSIS10000000000000&serviceId=STATSCU0100000140';
const REFERER = 'https://data.krx.co.kr/contents/MDC/MDI/outerLoader/index.cmd';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 stock-dashboard-krx-short/0.1';

const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number(args['timeout-ms'] || 15000);
const writeOutput = args.write !== false;
const endDd = String(args.endDd || args.date || formatKstDateCompact(new Date()));
const days = Number(args.days || 370);
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
      balanceByIssueTrend: 'dbms/MDC/STAT/srt/MDCSTAT30502',
      securitiesLendingTrend: 'KOFIA FreeSIS STATSCU0100000140BO'
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
    const loanRows = await fetchFreeSisLoanRows(stock, { strtDd, endDd, timeoutMs });
    items.push(buildStockPayload(stock, tradingRows, balanceRows, loanRows));
    await sleep(350);
  }
  const usable = items.some(item => item.latestTrading || item.latestBalance);
  const payload = {
    id: 'krx_short_selling_daily',
    status: usable ? 'ok' : 'no_data',
    startedAt,
    generatedAt: new Date().toISOString(),
    requestedRange: { strtDd, endDd },
    expectedLag: '잔고는 통상 T+2 안팎 지연 공시. 최근 370일을 훑어 최신 Flow와 확정 Position을 분리하고, 최소 60거래일 이상이면 종목별 percentile 기반으로 보정함.',
    source: 'KRX Data Marketplace short-selling statistics',
    sourcePaths: {
      tradingByIssueTrend: 'dbms/MDC/STAT/srt/MDCSTAT30102',
      balanceByIssueTrend: 'dbms/MDC/STAT/srt/MDCSTAT30502',
      securitiesLendingTrend: 'KOFIA FreeSIS STATSCU0100000140BO'
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

function buildStockPayload(stock, tradingRowsRaw, balanceRowsRaw, loanRowsRaw = []) {
  const tradingRows = normalizeTradingRows(tradingRowsRaw).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const balanceRows = normalizeBalanceRows(balanceRowsRaw).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const loanRows = normalizeLoanRows(loanRowsRaw).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
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
  const latestLoan = latestLoanForBalanceDate(loanRows, latestBalance?.tradeDate);
  const previousLoan = previousBefore(loanRows, latestLoan?.tradeDate);
  const loanStats = buildLoanStats(loanRows, latestLoan, latestBalance);
  const balanceStats = buildBalanceStats(balanceRows, latestBalance, previousBalance);
  const tradingStats = buildTradingStats(tradingRows, latestTrading);
  const dailyRecords = buildAlignedDailyRecords({ tradingRows, balanceRows, loanRows });
  const pressure = buildShortPressure(dailyRecords, tradingRows);
  return {
    ...stock,
    status: latestTrading || latestBalance ? 'ok' : 'no_data',
    latestTrading,
    previousTrading,
    latestBalance,
    previousBalance,
    latestLoan,
    previousLoan,
    deltas: {
      shortSellVolume: shortVolumeDelta,
      totalVolume: totalVolumeDelta,
      shortSellVolumeRatioPctp: shortRatioDeltaPctp,
      shortSellBalance: balanceDelta,
      shortSellBalancePct: latestBalance && previousBalance && previousBalance.shortSellBalance ? (balanceDelta / previousBalance.shortSellBalance) * 100 : null
    },
    balanceStats,
    tradingStats,
    loanStats,
    dailyRecords,
    pressure,
    signal: pressure.signal || buildShortSellingSignal({ balanceStats, tradingStats, loanStats, balanceDeltaPct: latestBalance && previousBalance && previousBalance.shortSellBalance ? (balanceDelta / previousBalance.shortSellBalance) * 100 : null }),
    displayNote: latestTrading && latestTrading.tradeDate !== lastWithDate(tradingRows)?.tradeDate ? '당일 공매도 0 표시는 장중/확정 전 예비값으로 판단해 최신 확정 거래일을 표시' : null,
    history: tradingRows.slice(-20).map(row => ({ 
      tradeDate: row.tradeDate,
      shortSellVolume: row.shortSellVolume,
      totalVolume: row.totalVolume,
      shortSellVolumeRatioPct: row.shortSellVolumeRatioPct
    })),
    balanceHistory: balanceRows.slice(-20).map(row => ({
      tradeDate: row.tradeDate,
      shortSellBalance: row.shortSellBalance,
      listedShares: row.listedShares,
      balanceRatioPct: row.balanceRatioPct
    })),
    loanHistory: loanRows.slice(-20).map(row => ({
      tradeDate: row.tradeDate,
      loanBalance: row.loanBalance,
      loanTradeNew: row.loanTradeNew,
      loanTradeRedeem: row.loanTradeRedeem
    }))
  };
}

async function fetchFreeSisLoanRows(stock, { strtDd, endDd, timeoutMs }) {
  const response = await fetch(FREESIS_LOAN_URL, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT,
      'content-type': 'application/json; charset=UTF-8',
      'accept': 'application/json, text/plain, */*',
      'referer': FREESIS_REFERER
    },
    body: JSON.stringify({
      dmSearch: {
        tmpV40: '1000000',
        tmpV41: '1',
        tmpV1: 'D',
        tmpV45: strtDd,
        tmpV46: endDd,
        tmpV72: stock.ticker,
        OBJ_NM: 'STATSCU0100000140BO'
      }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`FreeSIS loan HTTP ${response.status}: ${text.slice(0, 200)}`);
  if (!json) throw new Error(`FreeSIS loan non-JSON response: ${text.slice(0, 200)}`);
  return Array.isArray(json.ds1) ? json.ds1 : [];
}

function buildAlignedDailyRecords({ tradingRows, balanceRows, loanRows }) {
  const tradingByDate = new Map(tradingRows.map(row => [row.tradeDate, row]));
  const balanceByDate = new Map(balanceRows.map(row => [row.tradeDate, row]));
  const loanByDate = new Map(loanRows.map(row => [row.tradeDate, row]));
  const dates = [...new Set([...tradingByDate.keys(), ...balanceByDate.keys(), ...loanByDate.keys()])].sort();
  const records = dates.map(date => {
    const trading = tradingByDate.get(date) || null;
    const balance = balanceByDate.get(date) || null;
    const loan = loanByDate.get(date) || null;
    const shortBalanceRaw = balance?.shortSellBalance ?? null;
    // KRX sometimes returns structural/placeholder zeroes in historical windows.
    // Keep the raw row visible, but exclude non-positive balances from confirmed-position scoring.
    const shortBalance = shortBalanceRaw && shortBalanceRaw > 0 ? shortBalanceRaw : null;
    const loanBalance = loan?.loanBalance ?? null;
    const shortLoanRatio = shortBalance !== null && loanBalance ? (shortBalance / loanBalance) * 100 : null;
    const loanNet = loan?.loanTradeNew !== null && loan?.loanTradeRedeem !== null && loan?.loanTradeNew !== undefined && loan?.loanTradeRedeem !== undefined
      ? loan.loanTradeNew - loan.loanTradeRedeem
      : null;
    return {
      tradeDate: date,
      shortSaleVolume: trading?.shortSellVolume ?? null,
      shortSaleValue: trading?.shortSellValue ?? null,
      totalVolume: trading?.totalVolume ?? null,
      shortSaleRatioPct: trading?.shortSellVolumeRatioPct ?? null,
      shortBalance,
      shortBalanceRaw,
      shortBalanceRatioPct: shortBalance === null ? null : balance?.balanceRatioPct ?? null,
      loanNew: loan?.loanTradeNew ?? null,
      loanReturn: loan?.loanTradeRedeem ?? null,
      loanNet,
      loanBalance,
      shortLoanRatioPct: shortLoanRatio,
      dataDates: {
        shortTradeDate: trading?.tradeDate ?? null,
        shortBalanceDate: shortBalance === null ? null : balance?.tradeDate ?? null,
        loanDate: loan?.tradeDate ?? null
      },
      dataQuality: shortBalance !== null && loanBalance !== null ? 'confirmed_matched_date'
        : shortBalanceRaw === 0 ? 'structural_zero_or_missing_short_balance'
        : 'partial'
    };
  }).filter(row => row.shortSaleVolume !== null || row.shortBalanceRaw !== null || row.loanBalance !== null);

  for (let i = 0; i < records.length; i += 1) {
    const prevLoan = [...records.slice(0, i)].reverse().find(row => row.loanBalance);
    records[i].loanNetRatioPct = records[i].loanNet !== null && prevLoan?.loanBalance ? (records[i].loanNet / prevLoan.loanBalance) * 100 : null;
  }
  return records.slice(-370);
}

function buildShortPressure(records, tradingRows) {
  const confirmed = records.filter(row => row.shortBalance > 0 && row.loanBalance > 0 && row.shortLoanRatioPct !== null);
  const latest = confirmed.at(-1) || null;
  const previous = confirmed.at(-2) || null;
  const chg1 = changeBundle(latest, previous);
  const chg5 = changeBundle(latest, nthPrevious(confirmed, latest, 5));
  const chg10 = changeBundle(latest, nthPrevious(confirmed, latest, 10));
  const chg20 = changeBundle(latest, nthPrevious(confirmed, latest, 20));

  const finalizedTrading = latestFinalTradingRow(tradingRows);
  const latestFlowDate = finalizedTrading?.tradeDate || null;
  const latestFlowRow = records.filter(row => Number.isFinite(row.shortSaleRatioPct) && (!latestFlowDate || row.tradeDate <= latestFlowDate)).at(-1) || null;
  const flowRows = records.filter(row => Number.isFinite(row.shortSaleRatioPct) && (!latestFlowRow || row.tradeDate <= latestFlowRow.tradeDate));
  const recentFlow = flowRows.slice(-252);
  const shortVolumeRatio3d = avg(flowRows.slice(-3).map(row => row.shortSaleRatioPct));
  const shortVolumeRatio5d = avg(flowRows.slice(-5).map(row => row.shortSaleRatioPct));
  const shortVolumeRatio20d = avg(flowRows.slice(-20).map(row => row.shortSaleRatioPct));
  const shortFlowAcceleration = shortVolumeRatio3d !== null && shortVolumeRatio20d ? shortVolumeRatio3d / shortVolumeRatio20d : null;

  const latestLoanFlowRow = records.filter(row => Number.isFinite(row.loanNetRatioPct)).at(-1) || null;
  const loanFlowRows = records.filter(row => Number.isFinite(row.loanNetRatioPct) && (!latestLoanFlowRow || row.tradeDate <= latestLoanFlowRow.tradeDate));
  const loanNet3d = avg(loanFlowRows.slice(-3).map(row => row.loanNetRatioPct));
  const loanNet5d = avg(loanFlowRows.slice(-5).map(row => row.loanNetRatioPct));

  const historyCount = Math.min(recentFlow.length, confirmed.length || recentFlow.length);
  const confidence = historyCount >= 252 ? 'HIGH' : historyCount >= 60 ? 'MEDIUM' : 'LOW';
  const weights = confidence === 'LOW' ? { position: 0.60, flow: 0.40 } : confidence === 'MEDIUM' ? { position: 0.45, flow: 0.55 } : { position: 0.40, flow: 0.60 };

  const positionScore = buildPositionScore(confirmed, latest, chg10);
  const flowScore = buildFlowScore({ flowRows, latestFlowRow, shortFlowAcceleration, latestLoanFlowRow, loanNet3d });
  const nowcastScore = positionScore !== null && flowScore !== null
    ? Math.round(positionScore * weights.position + flowScore * weights.flow)
    : positionScore ?? flowScore ?? null;
  const signal = classifyNowcastShortPressure({ positionScore, flowScore, nowcastScore, latest, chg10, latestFlowRow, shortVolumeRatio20d, latestLoanFlowRow, confidence });

  return {
    basis: 'confirmed_position_plus_latest_flow_nowcast',
    windows: { oneD: chg1, fiveD: chg5, tenD: chg10, twentyD: chg20 },
    latest,
    confirmedPosition: latest ? {
      tradeDate: latest.tradeDate,
      shortBalance: latest.shortBalance,
      loanBalance: latest.loanBalance,
      shortLoanRatioPct: latest.shortLoanRatioPct,
      tenDay: chg10,
      score: positionScore
    } : null,
    latestFlow: latestFlowRow ? {
      tradeDate: latestFlowRow.tradeDate,
      shortSaleVolume: latestFlowRow.shortSaleVolume,
      totalVolume: latestFlowRow.totalVolume,
      shortSaleRatioPct: latestFlowRow.shortSaleRatioPct,
      shortVolumeRatio3d,
      shortVolumeRatio5d,
      shortVolumeRatio20d,
      shortFlowAcceleration,
      loanDate: latestLoanFlowRow?.tradeDate ?? null,
      loanNew: latestLoanFlowRow?.loanNew ?? null,
      loanReturn: latestLoanFlowRow?.loanReturn ?? null,
      loanNet: latestLoanFlowRow?.loanNet ?? null,
      loanNetRatioPct: latestLoanFlowRow?.loanNetRatioPct ?? null,
      loanNet3d,
      loanNet5d,
      score: flowScore,
      fiveDayAverageShortSaleRatioPct: shortVolumeRatio5d,
      vsFiveDayAveragePctp: latestFlowRow.shortSaleRatioPct !== null && shortVolumeRatio5d !== null ? latestFlowRow.shortSaleRatioPct - shortVolumeRatio5d : null
    } : null,
    scores: {
      positionScore,
      flowScore,
      nowcastScore,
      weights,
      confidence,
      historyCount
    },
    signal,
    dataQuality: latest && latestFlowRow ? 'confirmed_position_and_latest_flow' : latest ? 'confirmed_position_only' : latestFlowRow ? 'latest_flow_only' : 'missing',
    note: '공매도 거래량은 gross flow라 잔고에 더하지 않음. Nowcast는 T+2 확정 Position과 최신 Flow를 분리 결합한 압력 점수.'
  };
}

function buildPositionScore(confirmed, latest, chg10) {
  if (!latest) return null;
  const hist = buildChangeHistory(confirmed, 10);
  const shortTrendScore = metricScore(chg10?.shortBalancePct, hist.map(row => row.shortBalancePct), trendThresholdScore(chg10?.shortBalancePct, { strong: 20, watch: 5 }));
  const ratioTrendScore = metricScore(chg10?.shortLoanRatioPctp, hist.map(row => row.shortLoanRatioPctp), trendThresholdScore(chg10?.shortLoanRatioPctp, { strong: 1.5, watch: 0.5 }));
  const loanTrendScore = metricScore(chg10?.loanBalancePct, hist.map(row => row.loanBalancePct), trendThresholdScore(chg10?.loanBalancePct, { strong: 5, watch: 1.5 }));
  return weightedScore([
    [shortTrendScore, 0.45],
    [ratioTrendScore, 0.35],
    [loanTrendScore, 0.20]
  ]);
}

function buildFlowScore({ flowRows, latestFlowRow, shortFlowAcceleration, latestLoanFlowRow, loanNet3d }) {
  if (!latestFlowRow && !latestLoanFlowRow) return null;
  const shortVolumeRatioScore = metricScore(latestFlowRow?.shortSaleRatioPct, flowRows.slice(-252).map(row => row.shortSaleRatioPct), trendThresholdScore(latestFlowRow?.shortSaleRatioPct, { strong: 8, watch: 5 }));
  const accelScore = metricScore(shortFlowAcceleration, rollingAccelerationHistory(flowRows), accelerationThresholdScore(shortFlowAcceleration));
  const loanNet1dScore = metricScore(latestLoanFlowRow?.loanNetRatioPct, flowRows.map(row => row.loanNetRatioPct), trendThresholdScore(latestLoanFlowRow?.loanNetRatioPct, { strong: 3, watch: 1 }));
  const loanNet3dScore = metricScore(loanNet3d, rollingAverageHistory(flowRows, 'loanNetRatioPct', 3), trendThresholdScore(loanNet3d, { strong: 2, watch: 0.7 }));
  return weightedScore([
    [shortVolumeRatioScore, 0.40],
    [accelScore, 0.25],
    [loanNet1dScore, 0.20],
    [loanNet3dScore, 0.15]
  ]);
}

function buildChangeHistory(rows, window) {
  const out = [];
  for (let i = window; i < rows.length; i += 1) out.push(changeBundle(rows[i], rows[i - window]));
  return out.filter(Boolean);
}

function rollingAccelerationHistory(rows) {
  const out = [];
  for (let i = 19; i < rows.length; i += 1) {
    const three = avg(rows.slice(Math.max(0, i - 2), i + 1).map(row => row.shortSaleRatioPct));
    const twenty = avg(rows.slice(i - 19, i + 1).map(row => row.shortSaleRatioPct));
    if (three !== null && twenty) out.push(three / twenty);
  }
  return out;
}

function rollingAverageHistory(rows, key, window) {
  const out = [];
  for (let i = window - 1; i < rows.length; i += 1) out.push(avg(rows.slice(i - window + 1, i + 1).map(row => row[key])));
  return out.filter(Number.isFinite);
}

function metricScore(value, history, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const samples = history.filter(v => Number.isFinite(Number(v))).map(Number);
  if (samples.length >= 60) return Math.round(percentileRank(samples, n));
  return fallback;
}

function percentileRank(samples, value) {
  const below = samples.filter(v => v < value).length;
  const equal = samples.filter(v => v === value).length;
  return ((below + equal * 0.5) / samples.length) * 100;
}

function trendThresholdScore(value, { strong, watch }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= strong) return 90;
  if (n >= watch) return 70;
  if (n <= -strong) return 10;
  if (n <= -watch) return 30;
  return 50;
}

function accelerationThresholdScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 1.75) return 90;
  if (n >= 1.25) return 70;
  if (n <= 0.65) return 20;
  if (n <= 0.85) return 35;
  return 50;
}

function weightedScore(parts) {
  const usable = parts.filter(([score]) => Number.isFinite(Number(score)));
  if (!usable.length) return null;
  const weightSum = usable.reduce((sum, [, weight]) => sum + weight, 0);
  const score = usable.reduce((sum, [score, weight]) => sum + Number(score) * weight, 0) / weightSum;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function classifyNowcastShortPressure({ positionScore, flowScore, nowcastScore, latest, chg10, latestFlowRow, shortVolumeRatio20d, latestLoanFlowRow, confidence }) {
  if (nowcastScore === null) return { level: 'neutral', score: null, title: '데이터 대기', summary: '공매도/대차 데이터 수집 대기', confidence };
  const posHigh = Number(positionScore) >= 65;
  const posLow = Number(positionScore) <= 40;
  const flowHigh = Number(flowScore) >= 65;
  const flowLow = Number(flowScore) <= 40;
  let level = nowcastScore >= 70 ? 'high' : nowcastScore >= 58 ? 'watch' : nowcastScore <= 35 ? 'relief' : 'neutral';
  let title = level === 'high' ? '숏 압력 강화' : level === 'watch' ? '신규 숏 관찰' : level === 'relief' ? '숏 압력 완화' : '숏 압력 중립';
  if (posHigh && flowHigh) { level = 'high'; title = '숏 압력 지속/강화'; }
  else if (posLow && flowHigh) { level = 'watch'; title = '신규 숏 구축 선행 신호'; }
  else if (posHigh && flowLow) { level = 'relief'; title = '기존 숏 높지만 신규 압력 완화'; }
  else if (posLow && flowLow) { level = 'relief'; title = '숏커버/압력 완화'; }

  const parts = [];
  if (chg10?.shortBalancePct !== null && chg10?.shortBalancePct !== undefined) parts.push(`확정잔고 10D ${formatSignedNumber(chg10.shortBalancePct, 1)}%`);
  if (chg10?.shortLoanRatioPctp !== null && chg10?.shortLoanRatioPctp !== undefined) parts.push(`공매/대차 ${formatSignedNumber(chg10.shortLoanRatioPctp, 1)}%p`);
  if (latestFlowRow?.shortSaleRatioPct !== null && latestFlowRow?.shortSaleRatioPct !== undefined) {
    const avgText = shortVolumeRatio20d === null ? '' : ` vs 20D ${formatValue(shortVolumeRatio20d, 2)}%`;
    parts.push(`Flow ${formatValue(latestFlowRow.shortSaleRatioPct, 2)}%${avgText}`);
  }
  if (latestLoanFlowRow?.loanNetRatioPct !== null && latestLoanFlowRow?.loanNetRatioPct !== undefined) parts.push(`대차순증감 ${formatSignedNumber(latestLoanFlowRow.loanNetRatioPct, 2)}%`);
  if (confidence === 'LOW') parts.push('신뢰도 LOW');
  return { level, score: nowcastScore, title, summary: parts.join(' / ') || '큰 변화 없음', confidence };
}

function changeBundle(latest, base) {
  if (!latest || !base) return null;
  return {
    fromDate: base.tradeDate,
    toDate: latest.tradeDate,
    shortBalancePct: pctChange(latest.shortBalance, base.shortBalance),
    loanBalancePct: pctChange(latest.loanBalance, base.loanBalance),
    shortLoanRatioPctp: latest.shortLoanRatioPct !== null && base.shortLoanRatioPct !== null ? latest.shortLoanRatioPct - base.shortLoanRatioPct : null,
    shortBalanceDelta: latest.shortBalance !== null && base.shortBalance !== null ? latest.shortBalance - base.shortBalance : null,
    loanBalanceDelta: latest.loanBalance !== null && base.loanBalance !== null ? latest.loanBalance - base.loanBalance : null,
    shortLoanRatioFrom: base.shortLoanRatioPct,
    shortLoanRatioTo: latest.shortLoanRatioPct
  };
}

function nthPrevious(rows, latest, n) {
  if (!latest) return null;
  const idx = rows.findIndex(row => row.tradeDate === latest.tradeDate);
  if (idx === -1) return null;
  return rows[Math.max(0, idx - n)] || null;
}

function classifyShortPressure({ latest, chg10, latestFlow, flow5dAvgPct }) {
  if (!latest) return { level: 'neutral', score: null, title: '데이터 대기', summary: '공매도잔고/대차잔고 동일 날짜 매칭 대기' };
  const shortPct = Number(chg10?.shortBalancePct);
  const loanPct = Number(chg10?.loanBalancePct);
  const ratioPctp = Number(chg10?.shortLoanRatioPctp);
  const flowVsAvg = latestFlow?.shortSellVolumeRatioPct !== null && flow5dAvgPct !== null ? latestFlow.shortSellVolumeRatioPct - flow5dAvgPct : null;
  let score = 50;
  const parts = [];
  if (Number.isFinite(shortPct)) {
    if (shortPct >= 20) { score += 18; parts.push(`10D 공매잔고 ${formatSignedNumber(shortPct, 1)}%`); }
    else if (shortPct >= 5) { score += 8; parts.push(`10D 공매잔고 ${formatSignedNumber(shortPct, 1)}%`); }
    else if (shortPct <= -20) { score -= 18; parts.push(`10D 공매잔고 ${formatSignedNumber(shortPct, 1)}%`); }
    else if (shortPct <= -5) { score -= 8; parts.push(`10D 공매잔고 ${formatSignedNumber(shortPct, 1)}%`); }
  }
  if (Number.isFinite(ratioPctp)) {
    if (ratioPctp >= 1.5) { score += 14; parts.push(`공매/대차 +${formatValue(ratioPctp, 1)}%p`); }
    else if (ratioPctp >= 0.5) { score += 6; parts.push(`공매/대차 +${formatValue(ratioPctp, 1)}%p`); }
    else if (ratioPctp <= -1.5) { score -= 14; parts.push(`공매/대차 ${formatValue(ratioPctp, 1)}%p`); }
    else if (ratioPctp <= -0.5) { score -= 6; parts.push(`공매/대차 ${formatValue(ratioPctp, 1)}%p`); }
  }
  if (Number.isFinite(loanPct)) {
    if (loanPct >= 5 && Number.isFinite(shortPct) && shortPct > loanPct) { score += 6; parts.push('공매잔고가 대차보다 빠르게 증가'); }
    else if (loanPct >= 5 && (!Number.isFinite(shortPct) || shortPct <= 0)) { score -= 4; parts.push('대차는 늘지만 숏 증가는 약함'); }
    else if (loanPct <= -5 && Number.isFinite(shortPct) && shortPct < 0) { score -= 8; parts.push('대차상환+공매잔고 감소'); }
  }
  if (Number.isFinite(flowVsAvg)) {
    if (flowVsAvg >= 2) { score += 6; parts.push('당일 공매도 flow 5D 평균 상회'); }
    else if (flowVsAvg <= -2) { score -= 4; parts.push('당일 공매도 flow 둔화'); }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 70 ? 'high' : score >= 58 ? 'watch' : score <= 35 ? 'relief' : 'neutral';
  const title = level === 'high' ? 'SHORT PRESSURE 상승' : level === 'watch' ? 'SHORT PRESSURE 관찰' : level === 'relief' ? '숏 압력 완화' : '숏 압력 중립';
  return { level, score, title, summary: parts.join(' / ') || '10D 기준 큰 변화 없음' };
}

function pctChange(current, base) {
  return current !== null && base ? ((current / base) - 1) * 100 : null;
}

function formatSignedNumber(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${formatValue(n, decimals)}`;
}

function formatValue(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

function buildLoanStats(loanRows, latestLoan, latestBalance) {
  const loanBalance = latestLoan?.loanBalance ?? null;
  const shortBalance = latestBalance?.shortSellBalance ?? null;
  const shortToLoanRatioPct = shortBalance !== null && loanBalance ? (shortBalance / loanBalance) * 100 : null;
  const rows = loanRows.filter(row => row.loanBalance !== null).slice(-60);
  const avgLoanBalance = avg(rows.map(row => row.loanBalance));
  const previous = previousBefore(loanRows, latestLoan?.tradeDate);
  const loanBalanceDelta = latestLoan && previous ? latestLoan.loanBalance - previous.loanBalance : null;
  const loanBalanceDeltaPct = latestLoan && previous?.loanBalance ? (loanBalanceDelta / previous.loanBalance) * 100 : null;
  return {
    source: 'KOFIA FreeSIS STATSCU0100000140BO',
    sampleCount: rows.length,
    latestDate: latestLoan?.tradeDate ?? null,
    loanBalance,
    loanTradeNew: latestLoan?.loanTradeNew ?? null,
    loanTradeRedeem: latestLoan?.loanTradeRedeem ?? null,
    avgLoanBalance,
    loanBalanceVsAvgPct: loanBalance !== null && avgLoanBalance ? ((loanBalance / avgLoanBalance) - 1) * 100 : null,
    loanBalanceDelta,
    loanBalanceDeltaPct,
    shortToLoanRatioPct
  };
}

function buildBalanceStats(balanceRows, latestBalance, previousBalance) {
  const rows = balanceRows.filter(row => row.shortSellBalance !== null && row.balanceRatioPct !== null).slice(-60);
  const ratios = rows.map(row => row.balanceRatioPct).filter(Number.isFinite);
  const balances = rows.map(row => row.shortSellBalance).filter(Number.isFinite);
  const avgRatioPct = avg(ratios);
  const avgBalance = avg(balances);
  const latestRatioPct = latestBalance?.balanceRatioPct ?? null;
  const latestBalanceQty = latestBalance?.shortSellBalance ?? null;
  const ratioVsAvgPctp = latestRatioPct !== null && avgRatioPct !== null ? latestRatioPct - avgRatioPct : null;
  const balanceVsAvgPct = latestBalanceQty !== null && avgBalance ? ((latestBalanceQty / avgBalance) - 1) * 100 : null;
  const prevBalanceQty = previousBalance?.shortSellBalance ?? null;
  const oneStepChangePct = latestBalanceQty !== null && prevBalanceQty ? ((latestBalanceQty - prevBalanceQty) / prevBalanceQty) * 100 : null;
  const last4 = rows.slice(-4);
  const threeStepChangePct = last4.length >= 4 && last4[0].shortSellBalance ? ((last4.at(-1).shortSellBalance - last4[0].shortSellBalance) / last4[0].shortSellBalance) * 100 : null;
  const ratioState = ratioVsAvgPctp === null ? 'unknown'
    : ratioVsAvgPctp >= 0.03 ? 'high'
    : ratioVsAvgPctp <= -0.03 ? 'low'
    : 'near_average';
  const momentum = threeStepChangePct === null ? 'unknown'
    : threeStepChangePct >= 10 ? 'surging'
    : threeStepChangePct >= 4 ? 'rising'
    : threeStepChangePct <= -10 ? 'falling_fast'
    : threeStepChangePct <= -4 ? 'falling'
    : 'stable';
  return {
    sampleCount: rows.length,
    latestRatioPct,
    avgRatioPct,
    ratioVsAvgPctp,
    avgBalance,
    balanceVsAvgPct,
    oneStepChangePct,
    threeStepChangePct,
    ratioState,
    momentum
  };
}

function buildTradingStats(tradingRows, latestTrading) {
  const rows = tradingRows.filter(row => row.shortSellVolumeRatioPct !== null && Number.isFinite(row.shortSellVolumeRatioPct) && row.tradeDate <= latestTrading?.tradeDate).slice(-60);
  const ratios = rows.map(row => row.shortSellVolumeRatioPct).filter(Number.isFinite);
  const volumes = rows.map(row => row.shortSellVolume).filter(Number.isFinite);
  const avgRatioPct = avg(ratios);
  const avgVolume = avg(volumes);
  const latestRatioPct = latestTrading?.shortSellVolumeRatioPct ?? null;
  const latestVolume = latestTrading?.shortSellVolume ?? null;
  return {
    sampleCount: rows.length,
    latestRatioPct,
    avgRatioPct,
    ratioVsAvgPctp: latestRatioPct !== null && avgRatioPct !== null ? latestRatioPct - avgRatioPct : null,
    avgVolume,
    volumeVsAvgPct: latestVolume !== null && avgVolume ? ((latestVolume / avgVolume) - 1) * 100 : null,
    ratioState: latestRatioPct === null || avgRatioPct === null ? 'unknown'
      : latestRatioPct >= avgRatioPct + 2 ? 'high'
      : latestRatioPct <= avgRatioPct - 2 ? 'low'
      : 'near_average'
  };
}

function buildShortSellingSignal({ balanceStats, tradingStats, loanStats, balanceDeltaPct }) {
  const parts = [];
  let level = 'neutral';
  const shortToLoan = Number(loanStats?.shortToLoanRatioPct);
  if (Number.isFinite(shortToLoan)) {
    if (shortToLoan >= 25) { parts.push('대차잔고 대비 공매도잔고 비율 높음'); level = 'high'; }
    else if (shortToLoan >= 10) { parts.push('대차잔고 대비 공매도잔고 비율 관찰권'); level = 'watch'; }
    else parts.push('대차잔고 대비 공매도 전환율 낮음');
  } else {
    parts.push('대차잔고 비율 산출 대기');
  }
  if (loanStats?.loanBalanceDeltaPct !== null && loanStats?.loanBalanceDeltaPct !== undefined) {
    if (loanStats.loanBalanceDeltaPct >= 5) { parts.push('대차잔고 증가'); if (level === 'neutral') level = 'watch'; }
    else if (loanStats.loanBalanceDeltaPct <= -5) parts.push('대차잔고 감소');
  }
  if (balanceDeltaPct !== null && balanceDeltaPct >= 10) { parts.push('공매도잔고 전회 대비 급증'); if (level === 'neutral') level = 'watch'; }
  if (tradingStats?.ratioState === 'high') { parts.push('당일 공매도 거래비중 평균 상회'); if (level === 'neutral') level = 'watch'; }
  const title = parts.length ? parts.slice(0, 2).join(' · ') : '대차/공매도 평균권';
  return { level, title, summary: parts.join(' / ') || '대차잔고 대비 공매도 전환율 기준 이상 신호 약함' };
}

function avg(values) {
  const nums = values.filter(v => Number.isFinite(Number(v))).map(Number);
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
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

function normalizeLoanRows(rows) {
  return rows.map(row => ({
    tradeDate: normalizeDate(row.TMPV1),
    issueName: row.TMPV2 || null,
    loanTradeNew: num(row.TMPV3),
    loanTradeRedeem: num(row.TMPV4),
    loanBalance: num(row.TMPV5),
    loanBalanceValue: num(row.TMPV6)
  })).filter(row => row.tradeDate && row.tradeDate !== '합계' && row.tradeDate !== '평균');
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

function latestLoanForBalanceDate(loanRows, balanceDate) {
  if (!balanceDate) return lastWithDate(loanRows);
  return loanRows.filter(row => row.tradeDate && row.tradeDate <= balanceDate).at(-1) || lastWithDate(loanRows);
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
  return {
    name: item.name,
    status: item.status,
    latestTrading: item.latestTrading?.tradeDate || null,
    shortSellVolume: item.latestTrading?.shortSellVolume ?? null,
    totalVolume: item.latestTrading?.totalVolume ?? null,
    shortSellBalanceDate: item.latestBalance?.tradeDate || null,
    shortSellBalance: item.latestBalance?.shortSellBalance ?? null,
    balanceRatioVsAvgPctp: item.balanceStats?.ratioVsAvgPctp ?? null,
    balanceMomentum: item.balanceStats?.momentum ?? null,
    signal: item.signal?.title || null,
    displayNote: item.displayNote || null
  };
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
