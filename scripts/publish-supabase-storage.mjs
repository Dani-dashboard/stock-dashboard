import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
await loadDotEnv(path.join(root, '.env'));

const enabled = process.env.SUPABASE_PUBLISH_ENABLED === '1';
const supabaseUrl = trimTrailingSlash(process.env.SUPABASE_URL || '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'stock-dashboard';
const prefix = normalizePrefix(process.env.SUPABASE_STORAGE_PREFIX || 'data');
const cacheControl = process.env.SUPABASE_STORAGE_CACHE_CONTROL || '30';
const publicBaseUrl = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}`;

const files = [
  { local: 'data/latest.json', remote: `${prefix}latest.json`, required: true },
  { local: 'data/events.json', remote: `${prefix}events.json`, required: true },
  { local: 'data/alerts-latest.json', remote: `${prefix}alerts-latest.json`, required: false }
];

if (!enabled) {
  console.log('[supabase] skipped: SUPABASE_PUBLISH_ENABLED is not 1');
  process.exit(0);
}

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

const uploaded = [];
for (const file of files) {
  const localPath = path.join(root, file.local);
  let body;
  try {
    body = await fs.readFile(localPath);
  } catch (err) {
    if (!file.required && err.code === 'ENOENT') continue;
    throw err;
  }

  assertJson(body, file.local);
  const url = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${file.remote.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `max-age=${cacheControl}`,
      'x-upsert': 'true'
    },
    body
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upload failed for ${file.local}: HTTP ${res.status} ${res.statusText} ${text}`);
  }

  uploaded.push({ local: file.local, url: `${publicBaseUrl}/${file.remote}` });
}

console.log(JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), bucket, uploaded }, null, 2));

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function normalizePrefix(value) {
  const clean = value.replace(/^\/+|\/+$/g, '');
  return clean ? `${clean}/` : '';
}

function assertJson(buffer, label) {
  try {
    JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
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
      const value = trimmed.slice(idx + 1).trim().replace(/^[\'\"]|[\'\"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
