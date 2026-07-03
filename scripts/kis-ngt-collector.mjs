import fs from 'node:fs/promises';
import path from 'node:path';

await loadDotEnv('.env');
const outFile = process.env.KIS_NGT_OUT || 'data/kis-ngt-latest.json';
const approvalKey = await getApprovalKey();
const wsUrl = process.env.KIS_WS_URL || (process.env.KIS_MODE === 'paper' ? 'ws://ops.koreainvestment.com:31000' : 'ws://ops.koreainvestment.com:21000');
const trId = process.env.KIS_NGT_TR_ID || 'H0MFCNT0';
const trKey = process.env.KIS_NGT_TR_KEY || '101V06';
const runMs = Number(process.env.KIS_NGT_COLLECTOR_RUN_MS || 0);

await writeLatest({ status: 'connecting', wsUrl, trId, trKey, updatedAt: new Date().toISOString() });
const ws = new WebSocket(wsUrl);
const started = Date.now();
let lastTick = null;
let subscribed = false;

if (runMs > 0) setTimeout(() => { try { ws.close(); } catch {} }, runMs);

await new Promise((resolve) => {
  ws.addEventListener('open', async () => {
    const subscribe = { header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' }, body: { input: { tr_id: trId, tr_key: trKey } } };
    ws.send(JSON.stringify(subscribe));
    await writeLatest({ status: 'subscribing', wsUrl, trId, trKey, updatedAt: new Date().toISOString() });
  });
  ws.addEventListener('message', async (event) => {
    const raw = String(event.data);
    if (raw.includes('PINGPONG')) { try { ws.send(raw); } catch {} }
    const parsed = parseMessage(raw, trId, trKey);
    if (parsed.kind === 'subscribe') subscribed = true;
    if (parsed.kind === 'tick') lastTick = parsed.tick;
    await writeLatest({ status: lastTick ? 'tick' : subscribed ? 'subscribed_waiting_tick' : 'connected', wsUrl, trId, trKey, subscribed, lastTick, lastMessage: parsed, updatedAt: new Date().toISOString(), elapsedMs: Date.now() - started });
  });
  ws.addEventListener('error', async (event) => {
    await writeLatest({ status: 'error', wsUrl, trId, trKey, message: event.message || 'websocket error', updatedAt: new Date().toISOString() });
  });
  ws.addEventListener('close', async () => {
    await writeLatest({ status: lastTick ? 'closed_after_tick' : subscribed ? 'closed_subscribed_no_tick' : 'closed', wsUrl, trId, trKey, subscribed, lastTick, updatedAt: new Date().toISOString(), elapsedMs: Date.now() - started });
    resolve();
  });
});

function parseMessage(raw, expectedTrId, trKey) {
  try {
    const json = JSON.parse(raw);
    if (json.header?.tr_id === 'PINGPONG') return { kind: 'pingpong', datetime: json.header.datetime };
    if (json.body?.msg1) return { kind: 'subscribe', rt_cd: json.body.rt_cd, msg_cd: json.body.msg_cd, msg1: json.body.msg1, header: json.header };
    return { kind: 'json', header: json.header, body: json.body };
  } catch {}
  const parts = raw.split('|');
  if (parts.length >= 4) {
    const trId = parts[1];
    const fields = parts.slice(3).join('|').split('^');
    if (trId === expectedTrId) {
      return { kind: 'tick', tick: {
        trId,
        trKey,
        futs_shrn_iscd: fields[0] || trKey,
        bsop_hour: fields[1] || null,
        futs_prdy_vrss: num(fields[2]),
        prdy_vrss_sign: fields[3] || null,
        futs_prdy_ctrt: num(fields[4]),
        futs_prpr: num(fields[5]),
        acml_vol: num(fields[10]),
        receivedAt: new Date().toISOString(),
        firstFields: fields.slice(0, 16)
      } };
    }
    return { kind: 'pipe', trId, firstFields: fields.slice(0, 12) };
  }
  return { kind: 'raw', rawPreview: raw.slice(0, 300) };
}

function num(v) { if (v === undefined || v === null || v === '') return null; const n = Number(String(v).replace(/,/g,'')); return Number.isFinite(n) ? n : null; }
async function writeLatest(obj) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, outFile);
}
async function getApprovalKey() {
  const base = process.env.KIS_MODE === 'paper' ? 'https://openapivts.koreainvestment.com:29443' : 'https://openapi.koreainvestment.com:9443';
  const res = await fetch(`${base}/oauth2/Approval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, secretkey: process.env.KIS_APP_SECRET }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.approval_key) throw new Error(`approval failed ${res.status}: ${json.msg1 || json.error_description || JSON.stringify(json)}`);
  return json.approval_key;
}
async function loadDotEnv(file) { const text = await fs.readFile(file, 'utf8'); for (const line of text.split(/\r?\n/)) { const t=line.trim(); if(!t||t.startsWith('#')) continue; const i=t.indexOf('='); if(i>0 && !(t.slice(0,i) in process.env)) process.env[t.slice(0,i)] = t.slice(i+1).trim().replace(/^[\'"]|[\'"]$/g,''); } }
