#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Safety net for hourly insight freshness.
# This is deterministic fallback automation, not the preferred OpenClaw-managed AI path.
# It prevents stale previous-hour insight from remaining on the dashboard when OpenClaw cron is unavailable.

npm run mi:migrate
npm run mi:ingest
npm run mi:features
npm run mi:state
npm run mi:export
npm run mi:hourly-context

CONTEXT_TS=$(node -e "const fs=require('fs'); const x=JSON.parse(fs.readFileSync('data/hourly-context.json','utf8')); process.stdout.write(x.timestamp || '')")
INSIGHT_TS=$(node -e "const fs=require('fs'); try { const x=JSON.parse(fs.readFileSync('data/hourly-ai-insight.json','utf8')); process.stdout.write(x.timestamp || '') } catch { process.stdout.write('') }")
INSIGHT_STATUS=$(node -e "const fs=require('fs'); try { const x=JSON.parse(fs.readFileSync('data/hourly-ai-insight.json','utf8')); process.stdout.write(x.engine?.status || '') } catch { process.stdout.write('') }")

if [[ "$INSIGHT_TS" == "$CONTEXT_TS" && "$INSIGHT_STATUS" == "openclaw_managed" ]]; then
  echo "[hourly-insight-fallback] openclaw-managed insight already fresh for $CONTEXT_TS; skip fallback"
else
  echo "[hourly-insight-fallback] writing deterministic fallback for $CONTEXT_TS (existing ts=$INSIGHT_TS status=$INSIGHT_STATUS)"
  npm run mi:hourly-insight
  npm run mi:persist-hourly-insight
fi

npm run publish:supabase
