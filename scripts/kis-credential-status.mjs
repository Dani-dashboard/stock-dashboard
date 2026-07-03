import fs from 'node:fs/promises';
import { kisCredentialLifecycle } from '../src/kis-credential-status.mjs';

await loadDotEnv('.env');
console.log(JSON.stringify(kisCredentialLifecycle(process.env), null, 2));

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
