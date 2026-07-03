#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
while true; do
  date '+[%Y-%m-%d %H:%M:%S] fetch start'
  npm run fetch || true
  npm run publish:supabase || true
  ALERT_EMAIL_WINDOW="${ALERT_EMAIL_WINDOW:-major-market-hours}" npm run alerts || true
  sleep 60
done
