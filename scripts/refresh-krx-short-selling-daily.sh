#!/bin/zsh
set -euo pipefail

ROOT="/Users/dani/.openclaw/workspace/projects/stock-dashboard"
cd "$ROOT"

mkdir -p data logs
LOCK_DIR="data/.krx-short-selling-refresh.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX short-selling refresh already running; skip"
  exit 0
fi

cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX short-selling daily refresh start"

# KRX short-selling disclosure commonly has a T+2-ish lag, especially for balance.
# Scan a wider recent window so the dashboard can compare current short balance
# against a meaningful rolling average and detect acceleration/deceleration.
node scripts/krx-short-selling-daily.mjs --days 80
npm run fetch
npm run publish:supabase

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) KRX short-selling daily refresh done"
