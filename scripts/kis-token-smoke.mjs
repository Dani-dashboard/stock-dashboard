import fs from 'node:fs/promises';
import path from 'node:path';
import { getKisAccessToken } from '../src/providers/kis.mjs';

await loadDotEnv(path.resolve('.env'));
const token = await getKisAccessToken(process.env, { timeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 8000), forceRefresh: process.argv.includes('--force') });
console.log(JSON.stringify({ ok: true, fromCache: token.fromCache, expiresAt: token.expiresAt, mode: process.env.KIS_MODE || 'prod' }, null, 2));

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
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
