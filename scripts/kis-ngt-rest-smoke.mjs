import fs from 'node:fs/promises';
import { requestKis } from '../src/providers/kis.mjs';

await loadDotEnv('.env');
const symbols = (process.env.KIS_NGT_REST_SYMBOLS || '101M6,101U6,101Z6,101H7,101V06,101W9000,A01606,01606').split(',').map(s => s.trim()).filter(Boolean);
const results = [];
for (const symbol of symbols) {
  try {
    const query = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: process.env.KIS_NGT_REST_DIV || 'NF', FID_INPUT_ISCD: symbol }).toString();
    const { json, url, trId } = await requestKis({ path: '/uapi/domestic-futureoption/v1/quotations/inquire-price', trId: 'FHMIF10000000', query }, process.env, { timeoutMs: 10000 });
    const output = json.output || json.output1 || json.output2 || json.output3 || {};
    results.push({
      symbol,
      ok: json.rt_cd === '0',
      msg: json.msg1 || null,
      trId,
      price: output.futs_prpr || output.bstp_nmix_prpr || null,
      change: output.futs_prdy_vrss || output.prdy_vrss || output.bstp_nmix_prdy_vrss || null,
      changePct: output.futs_prdy_ctrt || output.prdy_ctrt || output.bstp_nmix_prdy_ctrt || null,
      time: output.stck_cntg_hour || output.bsop_hour || null,
      name: output.hts_kor_isnm || output.prdt_name || null,
      outputKeys: Object.keys(output).slice(0, 25),
      sourceUrl: url.replace(/(appsecret|appkey)=[^&]+/g, '$1=redacted')
    });
  } catch (err) {
    results.push({ symbol, ok: false, error: err.message });
  }
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), mode: process.env.KIS_MODE || 'prod', results }, null, 2));

async function loadDotEnv(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i > 0 && !(s.slice(0, i) in process.env)) process.env[s.slice(0, i)] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
