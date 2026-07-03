import fs from 'node:fs/promises';
import { requestKis } from '../src/providers/kis.mjs';

await loadDotEnv('.env');
const [,, path, trId, query=''] = process.argv;
if (!path || !trId) {
  console.error('Usage: node scripts/kis-rest-smoke.mjs <path> <trId> [query]');
  process.exit(2);
}
const { json, url, trId: usedTrId, tokenFromCache } = await requestKis({ path, trId, query }, process.env, { timeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 8000) });
console.log(JSON.stringify({ ok:true, url, trId: usedTrId, tokenFromCache, rt_cd: json.rt_cd, msg_cd: json.msg_cd, msg1: json.msg1, keys: Object.keys(json), outputPreview: preview(json.output), output1Preview: preview(json.output1), output2Preview: preview(json.output2) }, null, 2));

function preview(v) {
  if (Array.isArray(v)) return v.slice(0, 3);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 30));
  return v ?? null;
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
      const value = trimmed.slice(idx + 1).trim().replace(/^[\'"]|[\'"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}
