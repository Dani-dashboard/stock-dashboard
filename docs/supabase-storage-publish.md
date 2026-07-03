# Supabase Storage Publish Runbook

Option A structure:

```text
iMac 1-minute fetch loop
  -> data/latest.json, data/events.json
  -> Supabase Storage bucket: stock-dashboard
  -> Vercel/static frontend fetches public JSON URLs
```

## Local `.env` values

Add these to `projects/stock-dashboard/.env` on the iMac only:

```bash
SUPABASE_PUBLISH_ENABLED=1
SUPABASE_URL=https://fkjulfhlpkwavrxegaju.supabase.co
SUPABASE_SERVICE_ROLE_KEY=PASTE_SERVICE_ROLE_KEY_HERE
SUPABASE_STORAGE_BUCKET=stock-dashboard
SUPABASE_STORAGE_PREFIX=data
SUPABASE_STORAGE_CACHE_CONTROL=30
```

Never put `SUPABASE_SERVICE_ROLE_KEY` in frontend code, GitHub, Vercel public env, or chat.

## Manual test

```bash
cd /Users/dani/.openclaw/workspace/projects/stock-dashboard
npm run publish:supabase
```

Expected result: JSON output with uploaded public URLs.

## Public URLs

```text
https://fkjulfhlpkwavrxegaju.supabase.co/storage/v1/object/public/stock-dashboard/data/latest.json
https://fkjulfhlpkwavrxegaju.supabase.co/storage/v1/object/public/stock-dashboard/data/events.json
https://fkjulfhlpkwavrxegaju.supabase.co/storage/v1/object/public/stock-dashboard/data/alerts-latest.json
```

## Loop integration

`scripts/run-every-minute.sh` now runs:

```text
npm run fetch
npm run publish:supabase
npm run alerts
```

If `SUPABASE_PUBLISH_ENABLED` is not `1`, publish safely skips.
