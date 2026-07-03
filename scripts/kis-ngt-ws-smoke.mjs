import fs from 'node:fs/promises';

await loadDotEnv('.env');
const approvalKey = await getApprovalKey();
const wsUrl = process.env.KIS_WS_URL || (process.env.KIS_MODE === 'paper' ? 'ws://ops.koreainvestment.com:31000' : 'ws://ops.koreainvestment.com:21000');
const trId = process.env.KIS_NGT_TR_ID || 'H0MFCNT0';
const trKey = process.env.KIS_NGT_TR_KEY || '101W9000';
const waitMs = Number(process.env.KIS_WS_SMOKE_WAIT_MS || 12000);

console.log(JSON.stringify({ step: 'connect', wsUrl, trId, trKey, waitMs }, null, 2));
const ws = new WebSocket(wsUrl);
const started = Date.now();
const messages = [];

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    try { ws.close(); } catch {}
    resolve();
  }, waitMs);

  ws.addEventListener('open', () => {
    const subscribe = {
      header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
      body: { input: { tr_id: trId, tr_key: trKey } }
    };
    ws.send(JSON.stringify(subscribe));
    messages.push({ type: 'sent', subscribe: { trId, trKey } });
  });

  ws.addEventListener('message', async (event) => {
    const raw = String(event.data);
    if (raw.includes('PINGPONG')) {
      try { ws.send(raw); } catch {}
    }
    messages.push(parseMessage(raw));
    if (messages.length >= 5) {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve();
    }
  });

  ws.addEventListener('error', (event) => {
    messages.push({ type: 'error', message: event.message || 'websocket error' });
  });

  ws.addEventListener('close', () => {
    clearTimeout(timer);
    resolve();
  });
});

console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - started, messages }, null, 2));

function parseMessage(raw) {
  try {
    const json = JSON.parse(raw);
    return { type: 'json', header: json.header, body: json.body };
  } catch {}
  const parts = raw.split('|');
  if (parts.length >= 4) {
    const data = parts.slice(3).join('|');
    const fields = data.split('^');
    return { type: 'pipe', trId: parts[1], count: parts[2], firstFields: fields.slice(0, 12), rawPreview: raw.slice(0, 300) };
  }
  return { type: 'raw', rawPreview: raw.slice(0, 300) };
}

async function getApprovalKey() {
  const base = process.env.KIS_MODE === 'paper' ? 'https://openapivts.koreainvestment.com:29443' : 'https://openapi.koreainvestment.com:9443';
  const res = await fetch(`${base}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, secretkey: process.env.KIS_APP_SECRET })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.approval_key) throw new Error(`approval failed ${res.status}: ${json.msg1 || json.error_description || JSON.stringify(json)}`);
  return json.approval_key;
}

async function loadDotEnv(file) {
  const text = await fs.readFile(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^[\'"]|[\'"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
