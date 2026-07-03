# Vercel Deploy Runbook

This dashboard frontend is static. It reads live JSON from Supabase Storage by default:

```text
https://fkjulfhlpkwavrxegaju.supabase.co/storage/v1/object/public/stock-dashboard/data/latest.json
https://fkjulfhlpkwavrxegaju.supabase.co/storage/v1/object/public/stock-dashboard/data/events.json
```

No service role key is needed on Vercel.

## Recommended deploy path

Use GitHub import if possible:

1. Push `projects/stock-dashboard` to a private GitHub repository.
2. In Vercel: Add New Project -> Import Git Repository.
3. Framework Preset: `Other`.
4. Root Directory: repository root if this folder is the repo root.
5. Build Command: leave empty or `npm run check` only if Vercel asks.
6. Output Directory: `.`
7. Environment Variables: none required for the current static frontend.

## Direct Vercel CLI alternative

From this folder:

```bash
cd /Users/dani/.openclaw/workspace/projects/stock-dashboard
npx vercel
```

If asked:

- Link to existing project? `N` for first deploy
- Project name: `stock-dashboard`
- Directory: `./`
- Build command: none
- Output directory: `.`

## Important security note

Do not add `SUPABASE_SERVICE_ROLE_KEY` to Vercel. The frontend only needs public JSON URLs.

`.vercelignore` excludes `.env`, logs, local JSON snapshots, token caches, and node_modules.
